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

/// How long `stop` waits for the OS to actually release the listening socket.
///
/// A backstop, not an expected delay: the wait ends as soon as the port is
/// bindable again. It only exists so a wedged socket cannot hang shutdown.
const PORT_RELEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How often that wait re-checks the port while waiting.
const PORT_RELEASE_POLL: std::time::Duration = std::time::Duration::from_millis(5);

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
    ///
    /// The port is not released the instant `Server` is dropped. `tiny_http`
    /// closes its listener from an INTERNAL accept thread, woken by the
    /// self-connect in its `Drop`, so the socket can outlive this call by a few
    /// milliseconds. Returning early made this method break its own contract:
    /// the very next `apply` re-bound the same port and failed with
    /// `bind_failed`, which is how "applying the same configuration twice"
    /// stopped being safe. So the release is WAITED FOR, bounded, rather than
    /// assumed — the caller is told the port is free only when it genuinely is.
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
        self.await_port_release();
    }

    /// Block until this listener's port is genuinely free, or the deadline ends.
    ///
    /// This waits on a CONDITION (the port becoming bindable again), not on a
    /// fixed delay, so it returns as soon as the socket is really gone. The
    /// bound is a backstop so a wedged socket can never hang shutdown; a genuine
    /// leak is still reported by the tests that assert the port is reusable.
    fn await_port_release(&self) {
        let deadline = std::time::Instant::now() + PORT_RELEASE_TIMEOUT;
        loop {
            // Binding is the only reliable proof the listener is gone. The
            // probe socket is dropped immediately, before the next attempt.
            match std::net::TcpListener::bind(self.addr) {
                Ok(probe) => {
                    drop(probe);
                    return;
                }
                Err(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(PORT_RELEASE_POLL);
                }
                Err(_) => {
                    log::error!(
                        "local api: port {} is still bound after stop(); it may leak",
                        self.addr
                    );
                    return;
                }
            }
        }
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
/// `app` is the running application. It is what lets this listener serve the
/// two surfaces that need one — the embedded Station assets (`asset_resolver`)
/// and the real `State<AppState>` the commands reach — and it is what keeps the
/// browser on the same commands as the desktop instead of on a parallel
/// implementation.
///
/// It is OPTIONAL, and that is a deliberate distinction rather than a
/// convenience. The JSON API needs only the database, which this function
/// already receives. A listener with no handle still answers `/api/v1/health`
/// and every authenticated route for real; only the browser surface and the
/// command bridge report that they are unavailable, and they do so per request
/// ([`super::runtime::ERR_NO_APP_HANDLE`]) instead of the whole service refusing
/// to bind. Binding is decided by the address and the port, so an enabled
/// configuration that resolved an address must actually open its socket.
///
/// Returns a typed failure instead of panicking, because the caller — the
/// application startup path — must be able to carry on without the network.
pub fn start(
    addr: SocketAddr,
    conn: Arc<Mutex<crate::repositories::Db>>,
    app: Option<tauri::AppHandle>,
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
            .spawn(move || serve_forever(server, running, conn, app))
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
/// A thin seam over [`start`] rather than a second implementation: the browser
/// application and the command bridge are served from Tauri's embedded asset
/// set and need a real `AppHandle`, so those two surfaces only exist inside a
/// running application. Passing `None` serves the JSON API alone.
#[cfg(test)]
pub fn start_api_only(
    addr: SocketAddr,
    conn: Arc<Mutex<crate::repositories::Db>>,
) -> Result<ServerHandle, String> {
    start(addr, conn, None)
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
        return command_response(&req, name, app, conn);
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
    let rest = path
        .strip_prefix(API_PREFIX)?
        .strip_prefix(super::bridge::CMD_PREFIX)?;
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
///
/// The order below is the contract, and it is the same order the desktop IPC
/// layer uses: METHOD, then SESSION, then ARGUMENTS, and only then the command
/// itself. Each of those three is decided WITHOUT a running application,
/// because they are properties of the request, not of the server: a GET to a
/// command route is a 405 and a request with no token is a 401 whether or not a
/// Tauri handle happens to exist. Only the final step — actually invoking a
/// command — needs the application, so only that step reports its absence.
fn command_response(
    req: &ApiRequest,
    name: &str,
    app: Option<&tauri::AppHandle>,
    conn: &Arc<Mutex<crate::repositories::Db>>,
) -> ResponseBox {
    // 1. Method. Commands mutate state; only an explicit POST may run one.
    if !matches!(req.method.as_str(), "POST") {
        return error_response(&ApiError::method_not_allowed());
    }

    // 2. Session, resolved before anything else.
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

    // 3. Arguments. A body that is not JSON is a client error, not a crash.
    let body: serde_json::Value = if req.body.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_str(&req.body) {
            Ok(v) => v,
            Err(_) => return error_response(&ApiError::bad_request()),
        }
    };
    // A REQUIRED argument that is absent or null is refused here, as a 400,
    // rather than reaching the command and being defaulted into a business rule
    // being skipped. Checked against the same table the dispatch arms are built
    // from, so the two cannot drift.
    if let Some(missing) = super::bridge::missing_required_argument(name, &body) {
        log::debug!("local api: command {name} is missing required argument {missing}");
        return error_response(&ApiError::bad_request());
    }

    // 4. The command itself. Only this needs the running application, and its
    //    absence is reported honestly rather than answered with empty data.
    let app = match app {
        Some(app) => app,
        None => {
            log::error!("local api: no application handle; command {name} cannot run");
            return error_response(&ApiError::internal());
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

/// The commands that may run before anyone has signed in.
///
/// Named as a constant so the exemption is stated once and can be asserted
/// against the dispatch table, rather than being a list buried in a `matches!`
/// that only the HTTP layer and a human ever read.
pub const UNAUTHENTICATED_COMMANDS: &[&str] = &["login", "db_status", "list_login_accounts"];

/// Whether this command needs a valid session before it may run.
///
/// The single place this is decided, derived from the one list above. Three
/// commands are genuinely unauthenticated, and the reason each one is here is
/// worth recording, because getting the list wrong is not a cosmetic bug — it
/// decides whether a phone can reach the login screen AT ALL:
///
/// - `login`, which is how a session is obtained.
/// - `db_status`, the readiness probe the boot screen runs before anyone has
///   signed in.
/// - `list_login_accounts`, which the login screen must call to know who may
///   sign in. It is unauthenticated by construction (see `bridge.rs`): it
///   carries only an id, a display name and a role, and it grants nothing.
///
/// That last one used to be refused here. The Tauri IPC layer never had this
/// check — the command takes no token at all — so the desktop login screen
/// worked perfectly while the very same screen, served to a phone over the LAN
/// after a QR scan, received a 401 and rendered an error instead of the account
/// picker. Same bundle, same command, same database: the divergence was purely
/// this table, which is exactly the class of bug the two surfaces are supposed
/// to make impossible.
pub fn requires_session(name: &str) -> bool {
    !UNAUTHENTICATED_COMMANDS.contains(&name)
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
    // The classification asks the SAME embedded-bundle lookup the response
    // below uses, so "is this an asset?" and "are these its bytes?" can never
    // disagree: a well-formed `/assets/` path that is absent from the bundle is
    // classified `NotFound` up front and answered with an honest 404.
    match web::route_with(&req.path, |key| embedded_asset(app, key).is_some()) {
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
                Some((mime, bytes)) => asset_response(200, &mime, &bytes, web::cache_control(key)),
                None => error_response(&ApiError::not_found()),
            }
        }
        web::Route::NotFound => error_response(&ApiError::not_found()),
    }
}

/// The Station application shell.
fn shell(app: &tauri::AppHandle) -> ResponseBox {
    match embedded_asset(app, web::INDEX) {
        Some((mime, bytes)) => asset_response(200, &mime, &bytes, web::cache_control(web::INDEX)),
        // The shell must never be faked. If the asset set is unavailable we say
        // so honestly instead of returning a page that cannot boot.
        None => error_response(&ApiError::internal()),
    }
}

/// Whether a path is safe to hand to the embedded-asset resolver.
///
/// Structurally narrow: a bundle key is always `/`-rooted, forward-only and
/// free of `..`, a backslash and a NUL byte. Refused here rather than merely
/// filtered downstream, because no path is ever BUILT from client input — this
/// is the last gate before a string reaches the resolver.
pub fn is_embedded_key(key: &str) -> bool {
    key.starts_with('/')
        && !key.ends_with('/')
        && !key.contains("..")
        && !key.contains('\\')
        && !key.contains('\0')
        && !key.contains("//")
}

/// Look up an asset in the embedded bundle, with NO fallback of its own.
///
/// # THE ENCODING RULE — read this before touching the bytes
///
/// Tauri embeds `dist/` into the executable **Brotli-compressed** (`tauri`'s
/// default `compression` feature; `tauri-codegen` compresses every asset at
/// build time). Its two accessors are therefore NOT interchangeable:
///
/// - `AssetResolver::get()` is the **DECODING** accessor. It returns the
///   original bytes.
/// - `AssetResolver::iter()` is the **RAW** accessor. It yields the compressed
///   bytes exactly as they were compiled in.
///
/// Serving what `iter()` yields labels a Brotli stream `Content-Type:
/// text/html` with no `Content-Encoding` to accompany it, and every browser
/// renders that as a screenful of garbage instead of the Station page. That is
/// not hypothetical — it is what this function used to do, and it is why a
/// phone scanning the QR got binary noise rather than the application.
///
/// So the split below is deliberate and must stay this way: the iterator is
/// consulted for EXISTENCE only, and every byte written to a socket comes from
/// the decoding accessor.
///
/// `get()` is still asked for existence separately, because `get()` falls back
/// to `index.html` (and to `<path>.html`, then `<path>/index.html`) on a miss,
/// so a `Some` from it does not mean the file is there. Checking the map first
/// is what keeps a missing script an honest 404 instead of a 200 carrying a
/// whole HTML document.
///
/// The MIME type is the one Tauri derived from the **decoded** bytes, so the
/// type served is byte-for-byte the one the desktop webview gets.
///
/// `AssetResolver` is deliberately not used for existence alone: it rewrites a
/// miss into `index.html` (its own SPA behaviour), which is right for a webview
/// and wrong for an HTTP API, where it would turn a 404 into a misleading 200.
fn embedded_asset(app: &tauri::AppHandle, key: &str) -> Option<(String, Vec<u8>)> {
    // A key outside the embedded bundle is refused before the lookup.
    if !is_embedded_key(key) {
        return None;
    }
    // `AssetKey::from(Path)` normalises to a slash-separated path WITH a
    // leading slash on Unix, so the request path is already in the stored form
    // and is compared verbatim — no path is ever built from client input here.
    let resolver = app.asset_resolver();
    // EXISTENCE ONLY. The bytes this iterator yields are the compressed ones
    // and are deliberately discarded — see the note above.
    if !resolver
        .iter()
        .any(|(existing, _)| existing.as_ref() == key)
    {
        return None;
    }
    // BYTES. The decoding accessor, so the wire carries plain HTML/JS/CSS/PNG.
    let asset = resolver.get(key.to_string())?;
    Some((asset.mime_type, asset.bytes))
}

/// Write a frontend asset.
///
/// The body is written EXACTLY as the embedded bundle holds it and is NOT
/// compressed here. `tiny_http` sets `Content-Length` from the byte count and
/// no `Content-Encoding` is added, so the declared encoding and the actual
/// encoding cannot disagree — the simplest reliable path, and the only one that
/// is correct when the bytes are already plain.
///
/// The security headers are the same ones the API sends, plus the strict CSP:
/// this content is HTML and JavaScript executing in a browser on the same LAN
/// as the till, so it is held to at least the same standard.
///
/// `pub(crate)` so the byte-level HTTP contract it writes — status line, headers
/// and an uncompressed body — can be asserted directly, rather than inferred
/// from a browser that no automated test can drive.
pub(crate) fn asset_response(
    status: u16,
    content_type: &str,
    body: &[u8],
    cache_control: &str,
) -> ResponseBox {
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
        // `cache_control` is the fingerprint-aware policy from `web`, NOT a
        // blanket `no-store`. It used to be `no-store` for every response,
        // which forced a phone to re-download the entire multi-megabyte
        // fingerprinted bundle on every single page load and refresh — the
        // dominant cost in the LAN experience. The shell and the root assets
        // are still revalidated on every use, and no API or business response
        // ever passes through here: those keep their own `no-store`.
        ("Cache-Control", cache_control),
        // Nothing on this origin should ever be indexed, cached by a shared
        // phone, or leaked to a third party through a Referer header.
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
    if let Ok(h) = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// THE REGRESSION PIN for the QR login bug.
    ///
    /// The account picker must be reachable with NO session, on the LAN exactly
    /// as on the desktop. It used to be exempt nowhere, so a phone that had just
    /// scanned the QR got a 401 before the command ran and saw an error page
    /// where the account cards should have been.
    ///
    /// This asserts the property from both sides: the three genuinely public
    /// commands are reachable without a token, and NOTHING ELSE is — the
    /// exemption list cannot quietly grow into a way around authentication.
    #[test]
    fn only_the_public_commands_run_without_a_session() {
        for name in ["login", "db_status", "list_login_accounts"] {
            assert!(
                !requires_session(name),
                "{name} must be reachable before anyone has signed in"
            );
        }

        // Every other real command authenticates. Sampled across the surface,
        // and including the account-adjacent reads, because the failure mode
        // being guarded against is a picker that shows nobody while the rest of
        // the app keeps working.
        for name in [
            "me",
            "logout",
            "change_password",
            "list_products",
            "list_customers",
            "sales_overview",
            "local_access_qr",
            "get_network_config",
        ] {
            assert!(requires_session(name), "{name} must require a session");
        }
    }

    /// The exemption is only safe because it is ANCHORED to commands that carry
    /// no privilege. If a name were exempted while its dispatch arm still took a
    /// token, the two tables would disagree — the HTTP layer would let an
    /// unauthenticated caller reach a command whose own signature demands a
    /// session. Every public command must therefore take NO token at all.
    #[test]
    fn a_public_command_never_takes_a_token() {
        let src = include_str!("bridge.rs");
        for name in UNAUTHENTICATED_COMMANDS {
            let arm = src
                .lines()
                .find(|l| l.trim_start().starts_with(&format!("\"{name}\" =>")))
                .unwrap_or_else(|| panic!("{name} has no dispatch arm"));
            assert!(
                !arm.contains("token.to_owned()"),
                "{name} is public, so its arm must not demand a session token: {arm}"
            );
        }
    }

    /// A typo in a public name is the dangerous direction: it would silently
    /// re-authenticate the login screen, which is the exact defect this change
    /// fixes. So each exempted name must be a real dispatch arm.
    #[test]
    fn every_exempted_command_really_exists() {
        let src = include_str!("bridge.rs");
        for name in UNAUTHENTICATED_COMMANDS {
            assert!(
                src.lines()
                    .any(|l| l.trim_start().starts_with(&format!("\"{name}\" =>"))),
                "{name} is exempted from authentication but is not a command"
            );
        }
    }

    #[test]
    fn only_a_bundle_shaped_key_may_reach_the_asset_resolver() {
        /*
         * The last gate before a string becomes an embedded-asset lookup. The
         * allow-list is structural — `/`-rooted, forward-only, no `..`, no
         * backslash, no NUL — so nothing that names a filesystem location, a
         * database file, a `.env` or a build artefact can satisfy it.
         */
        for good in [
            "/index.html",
            "/assets/index-DqmH59mP.js",
            "/station-cafe.png",
        ] {
            assert!(is_embedded_key(good), "{good} must be allowed");
        }
        for bad in [
            "",
            "index.html",
            "assets/index.js",
            "/../Cargo.toml",
            "/assets/../../etc/passwd",
            "/..%2f..%2fsecret",
            "/assets\\..\\..\\secret",
            "/assets/\0.js",
            "//",
        ] {
            assert!(!is_embedded_key(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_wire_bytes_are_never_taken_from_the_raw_compressed_iterator() {
        /*
         * THE REGRESSION PIN.
         *
         * Tauri embeds `dist/` Brotli-compressed. `AssetResolver::iter()` yields
         * those RAW compressed bytes; only `AssetResolver::get()` decodes them.
         * Reading the page out of the iterator is what made
         * `http://<lan-ip>:47821/` return a Brotli stream labelled
         * `Content-Type: text/html` with no `Content-Encoding`, which a browser
         * renders as a screenful of binary garbage.
         *
         * The read path needs a running Tauri application, so it cannot be
         * exercised here — but the mistake is a one-line change, so the API
         * contract is pinned from the source instead. Comments are stripped
         * first: the module's own documentation necessarily NAMES `iter()` and
         * `get()` to explain the rule, and matching that prose would assert the
         * opposite of the intent.
         */
        let source = include_str!("server.rs");
        // Everything before the test module. `split("#[cfg(test)]")` alone would
        // be wrong: `start_api_only` carries the same attribute, so the naive
        // split would cut the production half in half and assert nothing.
        let module = source
            .find("#[cfg(test)]\nmod tests")
            .expect("server.rs keeps its tests in one trailing module");
        let production = &source[..module];
        let code: String = production
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && !l.starts_with("///") && !l.starts_with("//!"))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            code.contains("resolver.get("),
            "asset bytes must come from the DECODING accessor"
        );
        assert!(
            !code.contains("into_owned()"),
            "`into_owned()` only appeared to take the RAW compressed bytes off \
             the iterator; that is the binary-on-the-wire defect"
        );
        assert!(
            !code.contains("MimeType::parse"),
            "the MIME type must be the one Tauri derived from the DECODED bytes, \
             not sniffed from a compressed stream"
        );
    }
}
