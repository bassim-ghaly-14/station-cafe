//! The HTTP listener and its thread lifecycle.
//!
//! `tiny_http` is blocking and thread-per-connection, which matches the
//! application's synchronous `Mutex<Connection>` exactly. The server therefore
//! needs no async runtime, opens no second database connection, and shares the
//! one the POS already uses.
//!
//! Lifecycle rules this file exists to enforce:
//!
//! - The listener runs on its own thread, so it never keeps the process alive
//!   after the window closes.
//! - Failure to bind is REPORTED, never fatal. A cafe whose port is taken must
//!   still run its POS.
//! - `stop()` unblocks the accept loop and joins the thread, so the port is
//!   released and no background thread is left behind.

use crate::network::api::{self, ApiError, ApiRequest, ApiResponse};
use crate::network::web;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tiny_http::{Header, Response, ResponseBox, Server};

/// The login throttle. A process-wide singleton on purpose: it must be shared
/// by every connection thread, and it is intentionally NOT stored in the
/// database, so it cannot grow without bound and cannot be read by a client.
fn limiter_cell() -> &'static Mutex<Option<Arc<api::RateLimiter>>> {
    static CELL: OnceLock<Mutex<Option<Arc<api::RateLimiter>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// The shared login limiter, created on first use.
pub fn login_limiter() -> Arc<api::RateLimiter> {
    let mut cell = limiter_cell().lock().unwrap_or_else(|e| e.into_inner());
    if cell.is_none() {
        *cell = Some(api::RateLimiter::default_login());
    }
    cell.as_ref().expect("just initialised").clone()
}

/// Resets the limiter. Test-only seam so one test cannot leak attempts into
/// another through the process-wide singleton.
pub fn reset_login_limiter_for_tests() {
    let mut cell = limiter_cell().lock().unwrap_or_else(|e| e.into_inner());
    *cell = Some(api::RateLimiter::default_login());
}

/// A running listener. Dropping the handle does NOT stop the server; call
/// [`ServerHandle::stop`] so shutdown is explicit and observable.
pub struct ServerHandle {
    running: Arc<AtomicBool>,
    /// `Option` so `stop()` can DROP the server. `unblock()` alone only wakes
    /// the accept loop; the listening socket stays bound for as long as any
    /// `Server` value is alive. A cafe PC that kept the port after closing the
    /// till would refuse to reopen it next launch, so the handle releases it.
    server: Mutex<Option<Arc<Server>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    addr: SocketAddr,
}

impl ServerHandle {
    /// The address actually bound, which may differ from the requested one.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Stop accepting, release the port, and join the thread.
    ///
    /// Safe to call more than once. `unblock()` is what makes `recv()` return
    /// so the loop can observe the flag; dropping the last `Server` reference
    /// is what actually closes the listening socket.
    pub fn stop(&self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(server) = &server {
            server.unblock();
        }
        if let Some(handle) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = handle.join();
        }
        // Dropped here, after the accept thread has exited, so the listening
        // socket is closed and the port is immediately reusable.
        drop(server);
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        // Belt and braces: a dropped handle must not leave a bound port or a
        // live thread behind, even if the caller forgot to stop it.
        self.stop();
    }
}

/// Start the API on `addr`.
///
/// Returns a typed failure instead of panicking, because the caller — the
/// application startup path — must be able to carry on without the network.
pub fn start(
    addr: SocketAddr,
    conn: Arc<Mutex<crate::repositories::Db>>,
) -> Result<ServerHandle, String> {
    let server = Server::http(addr).map_err(|e| format!("cannot bind {addr}: {e}"))?;
    let bound = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "bound address is not an IP".to_string())?;
    let server = Arc::new(server);
    let running = Arc::new(AtomicBool::new(true));

    let thread = {
        let server = Arc::clone(&server);
        let running = Arc::clone(&running);
        std::thread::Builder::new()
            .name("station-api".into())
            .spawn(move || serve_forever(server, running, conn))
            .map_err(|e| format!("cannot start API thread: {e}"))?
    };

    Ok(ServerHandle {
        running,
        server: Mutex::new(Some(server)),
        thread: Mutex::new(Some(thread)),
        addr: bound,
    })
}

fn serve_forever(
    server: Arc<Server>,
    running: Arc<AtomicBool>,
    conn: Arc<Mutex<crate::repositories::Db>>,
) {
    while running.load(Ordering::SeqCst) {
        // `unblock()` makes this return an error once stopped, ending the loop.
        let mut request = match server.recv() {
            Ok(r) => r,
            Err(_) => break,
        };
        // tiny_http dispatches each connection on its own thread, so a slow
        // client can never block the POS or the accept loop.
        let response = respond(&mut request, &conn);
        // `respond` on the request consumes it, so it is called last.
        let _ = request.respond(response);
    }
}


/// Translate an HTTP request into a response.
///
/// Three surfaces, in this order, and never overlapping:
///
///   1. `/api/v1/*`  → [`api::handle`], JSON in and JSON out. Protected
///      routes, roles and the error shape are unchanged.
///   2. `/` and `/assets/*` → the embedded browser app, from [`web`].
///   3. anything else → a JSON 404. Never the HTML shell, so a mistyped API
///      path cannot be mistaken for a working endpoint, and a client parsing
///      JSON always gets JSON.
///
/// The database lock is taken only for an API request, and only for the
/// duration of the handler: serving a static asset must never contend with the
/// POS for the single shared connection.
fn respond(
    request: &mut tiny_http::Request,
    conn: &Arc<Mutex<crate::repositories::Db>>,
) -> ResponseBox {
    let req = match parse(request) {
        Ok(req) => req,
        Err(err) => return error_response(&err),
    };

    if !web::is_api_path(&req.path) {
        return web_response(&req);
    }

    let outcome = {
        let guard = match conn.lock() {
            Ok(g) => g,
            // A poisoned lock must not become an outage on the LAN.
            Err(_) => return error_response(&ApiError::internal()),
        };
        api::handle(&req, &guard)
    };

    match outcome {
        Ok(ApiResponse { status, body }) => json_response(status, &body),
        Err(err) => {
            // Server-side detail goes to the log; the client gets the code only.
            if err.status >= 500 {
                log::error!("local api: {} for {}", err.code, request.url());
            }
            error_response(&err)
        }
    }
}

/// Answer a non-API request from the embedded browser app.
fn web_response(req: &ApiRequest) -> ResponseBox {
    // Only GET and HEAD can address a document. A POST to `/` is a client
    // mistake, and answering it with the shell would be actively misleading.
    if !matches!(req.method.as_str(), "GET" | "HEAD") {
        return error_response(&ApiError::method_not_allowed());
    }
    match web::route(&req.path) {
        web::Route::Index => {
            let (content_type, body) = web::index();
            asset_response(200, content_type, body)
        }
        web::Route::Asset(asset) => asset_response(200, asset.content_type, asset.body),
        web::Route::NotFound => error_response(&ApiError::not_found()),
    }
}

/// Write an embedded asset.
///
/// The security headers are the same ones the API sends, plus a strict CSP:
/// this content is HTML and JavaScript executing in a browser on the same LAN
/// as the till, so it is held to at least the same standard.
fn asset_response(status: u16, content_type: &str, body: &'static [u8]) -> ResponseBox {
    let mut response = Response::from_data(body).with_status_code(status);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()) {
        response.add_header(h);
    }
    for (name, value) in [
        ("X-Content-Type-Options", "nosniff"),
        // The app must never be framed, so a cafe's page cannot clickjack a
        // manager's phone.
        ("X-Frame-Options", "DENY"),
        ("Content-Security-Policy", web::CSP),
        // Nothing on this origin should ever be indexed, cached by a shared
        // phone, or leaked to a third party through a Referer header.
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        if let Ok(h) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(h);
        }
    }
    response.boxed()
}

/// Parse a tiny_http request into the reduced shape handlers are allowed to see.
fn parse(request: &mut tiny_http::Request) -> Result<ApiRequest, ApiError> {
    let mut parts = request.url().splitn(2, '?');
    let raw_path = parts.next().unwrap_or("").to_string();
    let query = parts.next().unwrap_or("").to_string();

    // An oversized body is refused from its declared length BEFORE it is read,
    // so a large upload cannot be used to exhaust memory.
    if let Some(len) = request.body_length() {
        if len > api::MAX_BODY_BYTES {
            return Err(ApiError::payload_too_large());
        }
    }
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        return Err(ApiError::bad_request());
    }
    if body.len() > api::MAX_BODY_BYTES {
        return Err(ApiError::payload_too_large());
    }

    let authorization = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string());

    let client = request
        .remote_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(ApiRequest {
        method: request.method().as_str().to_string(),
        path: raw_path,
        query,
        authorization,
        client,
        body,
    })
}

fn json_response(status: u16, body: &serde_json::Value) -> ResponseBox {
    let text = body.to_string();
    let mut response = Response::from_string(text).with_status_code(status);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]) {
        response.add_header(h);
    }
    // Defence in depth: a POS must not be framed or content-sniffed by a
    // browser even on the LAN, and responses must never be cached.
    for (name, value) in [
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(h) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(h);
        }
    }
    response.boxed()
}

fn error_response(err: &ApiError) -> ResponseBox {
    // Exactly the documented shape: { "error": { code, message } }.
    let body = serde_json::json!({
        "error": { "code": err.code, "message": err.message }
    });
    json_response(err.status, &body)
}
