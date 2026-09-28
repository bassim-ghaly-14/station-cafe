//! The HTTP surface: routing, authentication, authorization, error boundary.
//!
//! Two rules define this file, and both exist to keep the network from
//! becoming a second, weaker way into the business:
//!
//! 1. NO BUSINESS LOGIC. A handler authenticates, authorizes, calls an existing
//!    `services::` function, and shapes the result. Anything that needs a rule,
//!    a calculation or SQL does not belong here.
//! 2. NO RAW ERRORS. A client never receives a rusqlite message, a filesystem
//!    path or an internal string. Everything crosses the boundary as one of the
//!    stable codes in [`ApiError`], exactly as the Tauri IPC layer does for
//!    the desktop UI.
//!
//! The surface is intentionally tiny: an unauthenticated health probe and two
//! authenticated identity endpoints. It proves the network boundary works
//! without exposing the POS.

use crate::error::AppError;
use crate::services::auth::{self, User};
use serde::Serialize;
use std::sync::{Arc, Mutex};

/// Every path served by this API is under this namespace, so the surface can
/// grow or be replaced without silently changing an existing client.
pub const API_PREFIX: &str = "/api/v1";

/// Maximum accepted request body. The API takes credentials, not documents;
/// anything larger is a mistake or an attack and is refused unread.
pub const MAX_BODY_BYTES: usize = 8 * 1024;

/// A failure as seen by an HTTP client.
///
/// Deliberately small and stable. `message` is a fixed, human-safe string —
/// never an error's own `Display`, which for rusqlite can contain SQL and for
/// IO can contain a filesystem path.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: u16,
}

impl ApiError {
    pub const fn new(code: &'static str, message: &'static str, status: u16) -> Self {
        Self {
            code,
            message,
            status,
        }
    }

    pub const fn bad_request() -> Self {
        Self::new("BAD_REQUEST", "Malformed request", 400)
    }

    pub const fn unauthorized() -> Self {
        Self::new("UNAUTHORIZED", "Authentication required", 401)
    }

    pub const fn not_found() -> Self {
        Self::new("NOT_FOUND", "Not found", 404)
    }

    pub const fn method_not_allowed() -> Self {
        Self::new("METHOD_NOT_ALLOWED", "Method not allowed", 405)
    }

    pub const fn payload_too_large() -> Self {
        Self::new("PAYLOAD_TOO_LARGE", "Request body too large", 413)
    }

    pub const fn rate_limited() -> Self {
        Self::new("RATE_LIMITED", "Too many attempts, try again later", 429)
    }

    pub const fn internal() -> Self {
        // The real cause is logged server-side; the client learns nothing.
        Self::new("INTERNAL", "Internal error", 500)
    }

    /// Translate a domain error into the HTTP boundary.
    ///
    /// The mapping is by error KIND, never by inspecting the message, so a new
    /// error variant cannot accidentally start leaking its text.
    pub fn from_domain(err: &AppError) -> Self {
        match err.kind() {
            crate::error::ErrorKind::Unauthorized => Self::unauthorized(),
            crate::error::ErrorKind::Validation | crate::error::ErrorKind::BusinessRule => {
                Self::new("BUSINESS_RULE", "Request refused", 422)
            }
            crate::error::ErrorKind::NotFound => Self::not_found(),
            crate::error::ErrorKind::Conflict => {
                Self::new("CONFLICT", "Request conflicts with current state", 409)
            }
            // Db, Internal and Io all collapse to one opaque response.
            _ => Self::internal(),
        }
    }
}

/// The identity a client is allowed to learn about itself.
///
/// A deliberate projection of [`User`], not the struct itself. `User` carries
/// a phone number and timestamps that a manager's phone has no business
/// reading about themselves over the LAN, and returning the whole row is how
/// fields leak into responses by accident later.
#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub id: i64,
    pub name: String,
    pub role: String,
}

impl From<&User> for Identity {
    fn from(u: &User) -> Self {
        Self {
            id: u.id,
            name: u.name.clone(),
            role: u.role.clone(),
        }
    }
}

/// Extract the bearer token from an `Authorization` header.
///
/// Returns `None` when the header is absent or is not a well-formed
/// `Bearer <token>`. Tokens are read ONLY from this header and never from the
/// query string, so a token cannot end up in a browser history, a proxy log, a
/// `Referer` header, or a screenshot of the address bar.
pub fn bearer_token(authorization: Option<&str>) -> Option<String> {
    let raw = authorization?;
    let (scheme, token) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    // The stored token is 48 hex chars. Rejecting anything else early keeps
    // junk out of the database lookup and bounds the work an attacker can do.
    if token.is_empty() || token.len() > 128 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(token.to_string())
}

/// Reject a token supplied in the query string.
///
/// Returning a distinct error makes the refusal visible to whoever tried it,
/// instead of leaving them to conclude the API is broken. The value is never
/// read, never logged and never used.
pub fn reject_query_token(query: &str) -> Option<ApiError> {
    for pair in query.split('&') {
        let key = pair.split('=').next().unwrap_or("");
        if matches!(key, "token" | "access_token" | "api_key" | "session") {
            return Some(ApiError::new(
                "TOKEN_IN_QUERY",
                "Send the token in the Authorization header",
                400,
            ));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Bounded, in-memory abuse protection
// ---------------------------------------------------------------------------

/// Fixed-window limiter for the login route, keyed by client address.
///
/// In memory only, and bounded on purpose: an attacker on the LAN must not be
/// able to make Station allocate without limit. A full map drops the oldest
/// entry rather than refusing new clients, so a burst cannot deny service to
/// the cafe's own manager.
#[derive(Debug)]
pub struct RateLimiter {
    window_secs: i64,
    max_attempts: u32,
    max_entries: usize,
    entries: Mutex<Vec<(String, i64, u32)>>,
}

impl RateLimiter {
    pub fn new(window_secs: i64, max_attempts: u32, max_entries: usize) -> Self {
        Self {
            window_secs,
            max_attempts,
            max_entries,
            entries: Mutex::new(Vec::new()),
        }
    }

    /// Production limiter: 10 attempts a minute per client, 256 clients.
    pub fn default_login() -> Arc<Self> {
        Arc::new(Self::new(60, 10, 256))
    }

    /// Record an attempt. `true` means the caller is allowed to proceed.
    ///
    /// A *successful* login clears the counter, so one mistyped password never
    /// accumulates toward a lockout that outlives the mistake.
    pub fn allow(&self, key: &str, now: i64) -> bool {
        let mut entries = match self.entries.lock() {
            Ok(e) => e,
            // A poisoned limiter must not become an outage: fail open here
            // rather than locking every manager out of their own cafe.
            Err(_) => return true,
        };
        // Drop entries from previous windows first.
        entries.retain(|(_, started, _)| now - *started < self.window_secs);

        match entries.iter_mut().find(|(k, _, _)| k == key) {
            Some((_, _, count)) => {
                *count += 1;
                *count <= self.max_attempts
            }
            None => {
                if entries.len() >= self.max_entries {
                    // Bounded memory: evict the oldest window entry.
                    entries.remove(0);
                }
                entries.push((key.to_string(), now, 1));
                true
            }
        }
    }

    /// Forget a client after a successful authentication.
    pub fn reset(&self, key: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(k, _, _)| k != key);
        }
    }

    /// Current entry count — used by tests to prove the map stays bounded.
    pub fn len(&self) -> usize {
        self.entries.lock().map(|e| e.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A parsed request, reduced to exactly what a handler is allowed to see.
#[derive(Debug, Clone)]
pub struct ApiRequest {
    pub method: String,
    /// Path with the `/api/v1` prefix removed and the query string dropped.
    pub path: String,
    /// Query string only, used solely to refuse a token sent in it.
    pub query: String,
    pub authorization: Option<String>,
    pub client: String,
    pub body: String,
}

/// A successful response, before serialization.
#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

/// Outcome of handling a request.
///
/// Handlers return this rather than writing to a socket, so the whole request
/// path is testable without opening a port.
pub type Handled = Result<ApiResponse, ApiError>;

/// Resolve the bind address for a configured value.
///
/// `LAN_INTERFACE` is resolved to this machine's real LAN address at bind
/// time. Nothing is hardcoded: on a machine with a VPN or several adapters
/// this picks the interface that actually carries the cafe's traffic, and the
/// API is never published on the others.
pub fn resolve_bind_address(bind: &str) -> Result<std::net::IpAddr, String> {
    let bind = bind.trim();
    if bind.is_empty() || bind == crate::network::config::LAN_INTERFACE {
        return local_ip_address::local_ip()
            .map_err(|e| format!("no LAN address available: {e}"));
    }
    bind.parse::<std::net::IpAddr>()
        .map_err(|_| format!("invalid bind address: {bind}"))
}

/// The health probe body.
///
/// Everything here is either already public in the application or a constant.
/// There is deliberately no database path, no customer or employee data, no row
/// counts, and nothing about the machine's configuration.
pub fn health_body(app_version: &str) -> serde_json::Value {
    serde_json::json!({
        "status": "ok",
        "service": "station-cafe",
        "api": "v1",
        "app_version": app_version,
    })
}

/// Dispatch one request.
///
/// This is the whole security surface in one function, which is the point: a
/// new route is either listed below with an explicit authentication and role
/// policy, or it does not exist.
pub fn handle(req: &ApiRequest, conn: &crate::repositories::Db) -> Handled {
    // A token in the query string is refused before anything else looks at it.
    if let Some(err) = reject_query_token(&req.query) {
        return Err(err);
    }

    // `parse` hands over the path exactly as it arrived, so the namespace is
    // STRIPPED here rather than assumed. Anything that is not under the
    // versioned prefix is unknown by construction, which is what keeps an
    // unversioned route from ever existing by accident.
    let Some(route) = req.path.strip_prefix(API_PREFIX) else {
        return Err(ApiError::not_found());
    };
    match (req.method.as_str(), route) {
        // ---- Unauthenticated: process liveness only ------------------------
        ("GET", "/health") => Ok(ApiResponse {
            status: 200,
            body: health_body(env!("CARGO_PKG_VERSION")),
        }),
        ("POST", "/auth/login") => login(req, conn),

        // ---- Authenticated + authorized ------------------------------------
        // MANAGER+ because the LAN API exists to give managers remote access.
        // A STAFF session is authenticated but is not a management client, and
        // must not gain access merely by being logged in.
        ("GET", "/me") => {
            let user = authenticate(req, conn)?;
            require_min_role(&user, "MANAGER")?;
            Ok(ApiResponse {
                status: 200,
                body: serde_json::json!({ "user": Identity::from(&user) }),
            })
        }

        // Delegates to the EXISTING service layer; no query is written here.
        ("GET", "/manager/summary") => {
            let user = authenticate(req, conn)?;
            require_min_role(&user, "MANAGER")?;
            let summary = crate::services::reports::today_summary(conn)
                .map_err(|e| ApiError::from_domain(&e))?;
            Ok(ApiResponse {
                status: 200,
                body: serde_json::json!({
                    "user": Identity::from(&user),
                    "open_day": summary.day.is_some(),
                }),
            })
        }

        // A known path reached with the wrong verb is a 405, not a 404: it
        // tells a legitimate client it used the wrong method without revealing
        // that some other method exists elsewhere.
        (_, path) if is_known_path(path) => Err(ApiError::method_not_allowed()),
        _ => Err(ApiError::not_found()),
    }
}

/// Known routes, expressed relative to `API_PREFIX` — the same strings the
/// match above uses, so the 405 arm cannot drift from the 404 arm.
fn is_known_path(route: &str) -> bool {
    matches!(route, "/health" | "/auth/login" | "/me" | "/manager/summary")
}

/// Resolve the session behind a request. Shared by every protected route.
fn authenticate(req: &ApiRequest, conn: &crate::repositories::Db) -> Result<User, ApiError> {
    // Only the header is read. The query string is refused in `handle`.
    let token = bearer_token(req.authorization.as_deref()).ok_or_else(ApiError::unauthorized)?;
    auth::require_user(conn, &token).map_err(|_| ApiError::unauthorized())
}

/// Authorization, using the application's own role ranking.
///
/// This is `auth::require_role` — the same function the Tauri commands use.
/// The network has no role logic of its own, so there is no second place for a
/// permission decision to drift.
fn require_min_role(user: &User, min: &str) -> Result<(), ApiError> {
    auth::require_role(user, min)
        .map_err(|_| ApiError::new("FORBIDDEN", "Insufficient permissions", 403))
}

/// `POST /api/v1/auth/login` — the only route that accepts a password.
fn login(req: &ApiRequest, conn: &crate::repositories::Db) -> Handled {
    let limiter = &crate::network::server::login_limiter();
    let now = crate::time::now_utc().timestamp();
    if !limiter.allow(&req.client, now) {
        return Err(ApiError::rate_limited());
    }

    #[derive(serde::Deserialize)]
    struct LoginBody {
        name: String,
        password: String,
    }

    let body: LoginBody = serde_json::from_str(&req.body).map_err(|_| ApiError::bad_request())?;

    // Delegates to the SAME service the desktop login uses, so a network client
    // and the POS share one password check, one session table and one audit
    // trail. A second password implementation is never introduced here.
    let session = auth::login(
        conn,
        &auth::LoginInput {
            name: body.name,
            password: body.password,
        },
    )
    .map_err(|_| ApiError::unauthorized())?;

    // A correct password clears the counter: one typo must not build toward a
    // lockout that outlives the mistake.
    limiter.reset(&req.client);

    Ok(ApiResponse {
        status: 200,
        body: serde_json::json!({
            "token": session.token,
            "user": Identity::from(&session.user),
        }),
    })
}
