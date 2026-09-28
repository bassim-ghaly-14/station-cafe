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
//!
//! THREE surfaces, served from ONE port by ONE listener:
//!
//!   1. `/api/v1/*`      → the JSON API (health, login) — [`api::handle`].
//!   2. `/api/v1/cmd/*`  → the REAL Station commands — [`bridge::call`]. This
//!      is what lets the browser run the actual application: the same
//!      `commands::*` functions the desktop invokes, so the same login, the
//!      same role checks and the same business rules.
//!   3. everything else  → the Station React application — [`web`], served
//!      from Tauri's own embedded assets so the phone gets the identical build
//!      the till runs, with an SPA fallback for client-side routes.
//!
//! A static asset is served WITHOUT taking the database lock, so browsing the
//! application can never contend with the POS for the single shared connection.

use crate::network::api::{self, ApiError, ApiRequest, ApiResponse, API_PREFIX};
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

/// Start the listener on `addr`.
///
/// The application handle is read from `state`. It is required, not optional,
/// because it is the ONLY route to the two things this listener serves: the
/// embedded Station assets (`asset_resolver`) and the real `State<AppState>`
/// the commands need. Using it is what keeps the browser on the same commands
/// as the desktop instead of on a parallel implementation.
///
/// Returns a typed failure instead of panicking, because the caller — the
/// application startup path — must be able to carry on without the network.
pub fn start(
    addr: SocketAddr,
    conn: Arc<Mutex<crate::repositories::Db>>,
    app: tauri::AppHandle,
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
            .spawn(move || serve_forever(server, running, conn, Some(app)))
            .map_err(|e| format!("cannot start API thread: {e}"))?
    };

    Ok(ServerHandle {
        running,
        server: Mutex::new(Some(server)),
        thread: Mutex::new(Some(thread)),
        addr: bound,
    })
}

/// Start the listener with NO application handle.
///
/// Test-only seam. The browser application and the command bridge are served
/// from Tauri's embedded asset set and need a real `AppHandle`; a unit test has
/// none, so this exposes the JSON API alone. Production always goes through
/// [`start`], which requires the handle — so this cannot be reached by a
/// running cafe application, and a missing handle is reported rather than
/// quietly degraded (see [`crate::network::runtime::ERR_NO_APP_HANDLE`]).
#[cfg(test)]
pub fn start_api_only(
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
            .name("station-api-test".into())
            .spawn(move || serve_forever(server, running, conn, None))
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
    app: Option<tauri::AppHandle>,
) {
    while running.load(Ordering::SeqCst) {
        // `unblock()` makes this return an error once stopped, ending the loop.
        let mut request = match server.recv() {
            Ok(r) => r,
            Err(_) => break,
        };
        // tiny_http dispatches each connection on its own thread, so a slow
        // client can never block the POS or the accept loop.
        let response = respond(&mut request, &conn, app.as_ref());
        // `respond` on the request consumes it, so it is called last.
        let _ = request.respond(response);
    }
}


/// Translate an HTTP request into a response.
///
/// Three surfaces, in this order, and never overlapping:
///
///   1. `/api/v1/cmd/*` → [`bridge::call`], which runs the real Station
///      commands. The bearer token comes from the `Authorization` header only.
///   2. `/api/v1/*`     → [`api::handle`], JSON in and JSON out.
///   3. everything else → the Station React application, with an SPA fallback.
///
/// The database lock is taken only for an API request, and only for the
/// duration of the handler: serving a static asset must never contend with the
/// POS for the single shared connection.
fn respond(
    request: &mut tiny_http::Request,
    conn: &Arc<Mutex<crate::repositories::Db>>,
    app: Option<&tauri::AppHandle>,
) -> ResponseBox {
    let req = match parse(request) {
        Ok(req) => req,
        Err(err) => return error_response(&err),
    };

    // 1. The real command surface.
    if let Some(name) = command_name(&req.path) {
        // Without a running application there are no real commands to call,
        // and that is reported honestly rather than answered with empty data.
        return match app {
            Some(app) => command_response(&req, name, app, conn),
            None => error_response(&ApiError::internal()),
        };
    }

    // 2. The JSON API.
    if web::is_api_path(&req.path) {
        let outcome = {
            let guard = match conn.lock() {
                Ok(g) => g,
                // A poisoned lock must not become an outage on the LAN.
                Err(_) => return error_response(&ApiError::internal()),
            };
            api::handle(&req, &guard)
        };
        return match outcome {
            Ok(ApiResponse { status, body }) => json_response(status, &body),
            Err(err) => {
                if err.status >= 500 {
                    log::error!("local api: {} for {}", err.code, request.url());
                }
                error_response(&err)
            }
        };
    }

    // 3. The Station application itself.
    match app {
        Some(app) => web_response(&req, app),
        // The shell must never be faked: with no asset set there is nothing
        // to serve, so say so rather than returning a page that cannot boot.
        None => error_response(&ApiError::internal()),
    }
}

/// The command name for `/api/v1/cmd/<name>`, if that is the path.
///
/// A command name is a plain lowercase identifier. Refusing anything else means
/// a traversal attempt, an empty name or an encoded separator can never be
/// forwarded as a command to look up.
pub fn command_name(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(API_PREFIX)?.strip_prefix(super::bridge::CMD_PREFIX)?;
    let name = rest.strip_prefix('/')?;
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return None;
    }
    Some(name)
}

/// Run one Station command and shape the outcome for the wire.
///
/// The token is read ONLY from the `Authorization` header. `api::reject_query_token`
/// has already refused a token sent in the query string, and the body is used
/// solely for command arguments, so a token can never appear in a URL.
fn command_response(
    req: &ApiRequest,
    name: &str,
    app: &tauri::AppHandle,
    conn: &Arc<Mutex<crate::repositories::Db>>,
) -> ResponseBox {
    if !matches!(req.method.as_str(), "POST") {
        return error_response(&ApiError::method_not_allowed());
    }

    // Resolve the SESSION before anything else.
    //
    // Authentication strictly precedes argument validation, exactly as it does
    // on the desktop, where the command receives its token first. Doing it the
    // other way round would let an unauthenticated caller probe the argument
    // shape and receive a 400 that implies a valid endpoint.
    //
    // The lock is taken only for this check and released again before the
    // command runs, because the command opens the SAME connection itself.
    let token = match api::bearer_token(req.authorization.as_deref()) {
        Some(token) => token,
        None if requires_session(name) => return error_response(&ApiError::unauthorized()),
        None => String::new(),
    };
    if requires_session(name) {
        let guard = match conn.lock() {
            Ok(g) => g,
            Err(_) => return error_response(&ApiError::internal()),
        };
        if crate::services::auth::require_user(&guard, &token).is_err() {
            return error_response(&ApiError::unauthorized());
        }
    }

    let body: serde_json::Value = if req.body.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_str(&req.body) {
            Ok(v) => v,
            Err(_) => return error_response(&ApiError::bad_request()),
        }
    };
    match crate::network::bridge::call(app, name, &token, &body) {
        Ok(ApiResponse { status, body }) => json_response(status, &body),
        Err(err) => {
            if err.status >= 500 {
                log::error!("local api: command {name} failed: {}", err.code);
            }
            error_response(&err)
        }
    }
}

/// Whether this command needs a valid session before it may run.
///
/// Only the two genuinely unauthenticated commands are exempt: `login`, which
/// is how a session is obtained, and `db_status`, the readiness probe the boot
/// screen runs before anyone has signed in. Everything else authenticates.
pub fn requires_session(name: &str) -> bool {
    !matches!(name, "login" | "db_status")
}

/// Answer a non-API request from the Station React application.
///
/// The bytes come from Tauri's own embedded asset set — the identical bundle
/// the desktop window loads — so there is exactly one frontend build in this
/// application and the browser can never be served something the till is not
/// running.
fn web_response(req: &ApiRequest, app: &tauri::AppHandle) -> ResponseBox {
    // Only GET and HEAD can address a document. A POST to `/` is a client
    // mistake, and answering it with the shell would be actively misleading.
    if !matches!(req.method.as_str(), "GET" | "HEAD") {
        return error_response(&ApiError::method_not_allowed());
    }
    match web::route(&req.path) {
        // The SPA fallback: a client-side route is answered with the SAME shell
        // as `/`, because the application — not the server — owns that routing.
        web::Route::Index | web::Route::Spa => shell(app),
        web::Route::Asset(key) => {
            // Tauri's own resolver falls back to `index.html` when an asset is
            // missing, so `Some(...)` does NOT mean the file exists. Asking the
            // embedded asset map directly is what makes a missing script a real
            // 404 instead of a 200 carrying a whole HTML document — which the
            // browser would report as a baffling JavaScript parse error.
            match embedded_asset(app, key) {
                Some((mime, bytes)) => asset_response(200, &mime, &bytes),
                None => error_response(&ApiError::not_found()),
            }
        }
        web::Route::NotFound => error_response(&ApiError::not_found()),
    }
}

/// The Station application shell.
fn shell(app: &tauri::AppHandle) -> ResponseBox {
    match embedded_asset(app, web::INDEX) {
        Some((mime, bytes)) => asset_response(200, &mime, &bytes),
        // The shell must never be faked. If the asset set is unavailable we say
        // so honestly instead of returning a page that cannot boot.
        None => error_response(&ApiError::internal()),
    }
}

/// Look up an asset in the embedded bundle, with NO fallback of its own.
///
/// This asks Tauri for the asset only when it is genuinely present. The
/// `AssetResolver` is deliberately not used: it rewrites a miss into
/// `index.html` (its own SPA behaviour), which is right for a webview and wrong
/// for an HTTP API, where it would turn a 404 into a misleading 200.
fn embedded_asset(app: &tauri::AppHandle, key: &str) -> Option<(String, Vec<u8>)> {
    // The embedded map is a perfect-hash lookup, so this is a cheap exact match
    // on the real file name. `AssetKey::from(Path)` normalises to a
    // slash-separated path WITH a leading slash on Unix, so the request path is
    // already in the stored form and is compared verbatim — no path is ever
    // built from client input here.
    let name = key;
    // A key outside the embedded bundle is refused before the lookup.
    if !name.starts_with('/') || name.contains("..") || name.contains('\\') {
        return None;
    }
    if !app
        .asset_resolver()
        .iter()
        .any(|(existing, _)| {
            // `existing` is a `Cow<AssetKey>`; `AssetKey` derefs to `str`.
            let existing: &str = existing.as_ref();
            existing == name
        })
    {
        return None;
    }
    app.asset_resolver()
        .get(name.to_string())
        .map(|asset| (asset.mime_type.to_string(), asset.bytes.to_vec()))
}

/// Write a frontend asset.
///
/// The security headers are the same ones the API sends, plus the strict CSP:
/// this content is HTML and JavaScript executing in a browser on the same LAN
/// as the till, so it is held to at least the same standard.
fn asset_response(status: u16, content_type: &str, body: &[u8]) -> ResponseBox {
    let mut response = Response::from_data(body.to_vec()).with_status_code(status);
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
