//! End-to-end tests for the local HTTP API's request handling.
//!
//! These drive the real `handle()` dispatcher against a real migrated and
//! seeded database — the same code path the socket serves — so they assert
//! actual behaviour rather than the shape of the code. A separate module (as
//! with `workflow_test`) keeps the feature's tests together and readable.

#![cfg(test)]

use crate::network::api::{self, ApiRequest};
use crate::services::auth;

fn fresh() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    crate::db::migrate(&conn).unwrap();
    crate::seed::run_if_empty(&conn).unwrap();
    conn
}

/// Builds a request with the path a real client would send, i.e. INCLUDING the
/// `/api/v1` namespace. Routing strips it; tests therefore exercise the same
/// string the socket delivers rather than a pre-stripped convenience.
fn req(method: &str, route: &str) -> ApiRequest {
    ApiRequest {
        method: method.into(),
        path: format!("{}{route}", api::API_PREFIX),
        query: String::new(),
        authorization: None,
        client: "10.0.0.9".into(),
        body: String::new(),
    }
}

fn with_token(mut r: ApiRequest, token: &str) -> ApiRequest {
    r.authorization = Some(format!("Bearer {token}"));
    r
}

fn login_token(conn: &rusqlite::Connection, name: &str) -> String {
    auth::login(
        conn,
        &auth::LoginInput {
            name: name.into(),
            password: format!("{name}123"),
        },
    )
    .unwrap()
    .token
}

fn login_body(name: &str, password: &str) -> ApiRequest {
    let mut r = req("POST", "/auth/login");
    r.body = serde_json::json!({ "name": name, "password": password }).to_string();
    r
}

// ---- health -------------------------------------------------------------

#[test]
fn health_is_reachable_without_credentials() {
    let conn = fresh();
    let out = api::handle(&req("GET", "/health"), &conn).unwrap();
    assert_eq!(out.status, 200);
    assert_eq!(out.body["status"], "ok");
    assert_eq!(out.body["service"], "station-cafe");
}

#[test]
fn health_leaks_no_path_no_data_and_no_counts() {
    let conn = fresh();
    let out = api::handle(&req("GET", "/health"), &conn).unwrap();
    let text = out.body.to_string();
    for leak in [".db", "station_cafe", "password", "customer", "invoice", "SELECT"] {
        assert!(!text.contains(leak), "health leaked {leak}: {text}");
    }
    let obj = out.body.as_object().unwrap();
    let mut keys: Vec<_> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, ["api", "app_version", "service", "status"]);
}

// ---- authentication -----------------------------------------------------

#[test]
fn a_protected_route_without_a_token_is_401() {
    let conn = fresh();
    for path in ["/me", "/manager/summary"] {
        let err = api::handle(&req("GET", path), &conn).unwrap_err();
        assert_eq!(err.status, 401, "{path}");
        assert_eq!(err.code, "UNAUTHORIZED");
    }
}

#[test]
fn a_protected_route_with_an_unknown_token_is_401() {
    let conn = fresh();
    let err = api::handle(&with_token(req("GET", "/me"), "deadbeef"), &conn).unwrap_err();
    assert_eq!(err.status, 401);
}

// ---- authorization ------------------------------------------------------

#[test]
fn staff_is_authenticated_but_refused_the_management_route() {
    // The network API exists for manager access. A cashier who logs in
    // successfully still must not read management data.
    let conn = fresh();
    let token = login_token(&conn, "cashier");
    for path in ["/me", "/manager/summary"] {
        let err = api::handle(&with_token(req("GET", path), &token), &conn).unwrap_err();
        assert_eq!(err.status, 403, "{path} must be forbidden for STAFF");
        assert_eq!(err.code, "FORBIDDEN");
    }
}

#[test]
fn an_admin_is_accepted_on_every_protected_route() {
    let conn = fresh();
    let token = login_token(&conn, "admin");
    for path in ["/me", "/manager/summary"] {
        assert_eq!(api::handle(&with_token(req("GET", path), &token), &conn).unwrap().status, 200);
    }
}

#[test]
fn the_role_decision_uses_the_shared_authorizer() {
    // Not a parallel implementation: the same ranking the desktop commands use.
    let conn = fresh();
    let staff = auth::require_user(&conn, &login_token(&conn, "cashier")).unwrap();
    assert!(auth::require_role(&staff, "MANAGER").is_err());
    let manager = auth::require_user(&conn, &login_token(&conn, "manager")).unwrap();
    assert!(auth::require_role(&manager, "MANAGER").is_ok());
}

// ---- data minimisation --------------------------------------------------

#[test]
fn the_identity_response_carries_no_phone_and_no_hash() {
    let conn = fresh();
    let token = login_token(&conn, "manager");
    let out = api::handle(&with_token(req("GET", "/me"), &token), &conn).unwrap();
    let user = out.body["user"].as_object().unwrap();
    let mut keys: Vec<_> = user.keys().map(|k| k.as_str()).collect();
    keys.sort();
    // Exactly id/name/role. No phone, no timestamps, no password material.
    assert_eq!(keys, ["id", "name", "role"]);
}

// ---- token handling -----------------------------------------------------


// ---- error boundary -----------------------------------------------------

#[test]
fn an_unknown_path_is_404_and_a_known_path_wrong_verb_is_405() {
    let conn = fresh();
    assert_eq!(api::handle(&req("GET", "/nope"), &conn).unwrap_err().status, 404);
    assert_eq!(api::handle(&req("POST", "/health"), &conn).unwrap_err().status, 405);
}

#[test]
fn an_unversioned_path_does_not_exist() {
    // The versioned namespace is not decoration: a route can only be reached
    // under /api/v1, so a future unversioned endpoint cannot appear by
    // accident and be treated as a different, unversioned contract.
    let conn = fresh();
    for path in ["/health", "/me", "/api/v2/health", "/api/health"] {
        let mut r = req("GET", "/");
        r.path = path.to_string();
        assert_eq!(api::handle(&r, &conn).unwrap_err().status, 404, "{path}");
    }
}

#[test]
fn a_malformed_login_body_is_a_clean_400() {
    let conn = fresh();
    let mut r = req("POST", "/auth/login");
    r.body = "not json".into();
    let err = api::handle(&r, &conn).unwrap_err();
    assert_eq!(err.status, 400);
    assert_eq!(err.code, "BAD_REQUEST");
}

#[test]
fn a_wrong_password_is_401_and_never_echoes_the_attempt() {
    let conn = fresh();
    let err = api::handle(&login_body("manager", "hunter2"), &conn).unwrap_err();
    assert_eq!(err.status, 401);
    assert!(!err.message.contains("hunter2"));
    assert!(!err.message.contains("manager"));
}

// ---- login --------------------------------------------------------------

#[test]
fn login_returns_a_usable_token_and_safe_identity() {
    let conn = fresh();
    crate::network::server::reset_login_limiter_for_tests();
    let out = api::handle(&login_body("manager", "manager123"), &conn).unwrap();
    assert_eq!(out.status, 200);
    assert_eq!(out.body["user"]["role"], "MANAGER");
    assert!(out.body["user"]["phone"].is_null(), "no phone is returned");

    // The token it hands out really works on a protected route.
    let token = out.body["token"].as_str().unwrap().to_string();
    assert_eq!(api::handle(&with_token(req("GET", "/me"), &token), &conn).unwrap().status, 200);
}

#[test]
fn a_network_login_uses_the_shared_session_table_and_is_audited() {
    // One session store for the POS and the network: a manager is not logged
    // into two separate worlds.
    let conn = fresh();
    crate::network::server::reset_login_limiter_for_tests();
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    api::handle(&login_body("manager", "manager123"), &conn).unwrap();
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, before + 1);
    let audited: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE action = 'auth.login'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(audited >= 1, "a network login must be audited like any other");
}

#[test]
fn repeated_failed_logins_are_throttled() {
    let conn = fresh();
    crate::network::server::reset_login_limiter_for_tests();
    for _ in 0..10 {
        assert_eq!(api::handle(&login_body("manager", "wrong"), &conn).unwrap_err().status, 401);
    }
    // The next attempt in the window is refused before any password is checked.
    assert_eq!(
        api::handle(&login_body("manager", "wrong"), &conn).unwrap_err().code,
        "RATE_LIMITED"
    );
}

#[test]
fn a_correct_login_is_never_locked_out_by_earlier_typos() {
    // The throttle must not become a denial of service against the cafe's own
    // manager: a successful authentication clears the counter.
    let conn = fresh();
    crate::network::server::reset_login_limiter_for_tests();
    for _ in 0..5 {
        let _ = api::handle(&login_body("manager", "typo"), &conn);
    }
    assert_eq!(api::handle(&login_body("manager", "manager123"), &conn).unwrap().status, 200);
}

// ---- bind resolution ----------------------------------------------------

#[test]
fn a_literal_bind_address_is_used_verbatim() {
    assert_eq!(api::resolve_bind_address("192.168.1.50").unwrap().to_string(), "192.168.1.50");
}

#[test]
fn an_invalid_bind_address_is_an_error_not_a_silent_default() {
    assert!(api::resolve_bind_address("not-an-ip").is_err());
}

// ---- real listener lifecycle -------------------------------------------
//
// These open an actual socket. They are the only way to prove the server
// really binds, really answers, and really releases the port on shutdown —
// none of which the pure `handle()` tests above can show.

/// A tiny blocking HTTP/1.1 client, so the test needs no HTTP dependency.
fn http_get(addr: std::net::SocketAddr, path: &str, header: Option<&str>) -> (u16, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    if let Some(h) = header {
        req.push_str(&format!("Authorization: {h}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let status: u16 = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status line");
    (status, raw)
}

#[test]
fn the_listener_serves_health_over_a_real_socket() {
    crate::network::server::reset_login_limiter_for_tests();
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start(addr, conn).expect("start");

    let (status, raw) = http_get(handle.local_addr(), "/api/v1/health", None);
    assert_eq!(status, 200, "{raw}");
    assert!(raw.contains("station-cafe"), "{raw}");

    // Protected routes are enforced on the real socket too.
    let (status, _) = http_get(handle.local_addr(), "/api/v1/me", None);
    assert_eq!(status, 401);

    handle.stop();
}

#[test]
fn a_bearer_token_authorizes_a_real_socket_request() {
    crate::network::server::reset_login_limiter_for_tests();
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start(addr, conn.clone()).expect("start");

    let token = login_token(&conn.lock().unwrap(), "manager");
    let (status, raw) = http_get(handle.local_addr(), "/api/v1/me", Some(&format!("Bearer {token}")));
    assert_eq!(status, 200, "{raw}");
    assert!(raw.contains("MANAGER"), "{raw}");

    handle.stop();
}

#[test]
fn stopping_the_server_releases_the_port() {
    // A cafe machine that keeps the port bound after the app closes would
    // refuse to reopen the till on the next launch.
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start(addr, conn.clone()).expect("start");
    let bound = handle.local_addr();
    assert!(std::net::TcpStream::connect(bound).is_ok(), "must be listening");

    handle.stop();
    assert!(!handle.is_running());

    // The listener must be GONE. The retry is deliberate and is what makes
    // this a real assertion rather than a flaky one: the client connection
    // above leaves a socket in TIME_WAIT, which the OS clears on its own, so
    // an immediate rebind can legitimately fail for a second. A genuine leak
    // — a listener that is still open — would fail FOREVER, so polling for a
    // bounded time separates "the OS is tidying up" from "we never closed it".
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut rebound = None;
    while std::time::Instant::now() < deadline {
        match crate::network::server::start(bound, conn.clone()) {
            Ok(h) => {
                rebound = Some(h);
                break;
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    let again = rebound.expect("port must become reusable after shutdown");
    assert_eq!(again.local_addr(), bound);
    again.stop();
}

#[test]
fn a_bind_failure_is_returned_not_panicked() {
    // "Address already in use" must reach the caller as a typed failure so
    // the app can carry on without the network.
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let first = crate::network::server::start(addr, conn.clone()).expect("start");
    let taken = first.local_addr();

    let second = crate::network::server::start(taken, conn);
    let message = match second {
        Ok(_) => panic!("binding a taken port must fail cleanly"),
        Err(e) => e,
    };
    // The message names the problem without leaking a stack trace.
    assert!(message.contains("cannot bind"), "{message}");

    first.stop();
}

#[test]
fn stopping_twice_is_safe() {
    // Shutdown can be reached from both the window event and Drop.
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start(addr, conn).expect("start");
    handle.stop();
    handle.stop();
    assert!(!handle.is_running());
}

#[test]
fn a_token_in_the_query_string_is_refused_before_anything_else() {
    let conn = fresh();
    let mut r = req("GET", "/me");
    r.query = "token=abc123".into();
    let err = api::handle(&r, &conn).unwrap_err();
    assert_eq!(err.code, "TOKEN_IN_QUERY");
    assert_eq!(err.status, 400);
}

#[test]
fn an_error_response_never_echoes_the_token() {
    let conn = fresh();
    let secret = "abcdef0123456789";
    let mut r = req("GET", "/me");
    r.authorization = Some(format!("Bearer {secret}"));
    let err = api::handle(&r, &conn).unwrap_err();
    let rendered = serde_json::json!({
        "error": { "code": err.code, "message": err.message }
    })
    .to_string();
    assert!(!rendered.contains(secret), "token echoed: {rendered}");
}


#[test]
fn a_revoked_token_is_401() {
    // Logout must invalidate a network session exactly as a desktop one,
    // because both read the same sessions table.
    let conn = fresh();
    let token = login_token(&conn, "manager");
    auth::logout(&conn, &token).unwrap();
    let err = api::handle(&with_token(req("GET", "/me"), &token), &conn).unwrap_err();
    assert_eq!(err.status, 401);
}

#[test]
fn a_valid_token_is_accepted() {
    let conn = fresh();
    let token = login_token(&conn, "manager");
    let out = api::handle(&with_token(req("GET", "/me"), &token), &conn).unwrap();
    assert_eq!(out.status, 200);
    assert_eq!(out.body["user"]["role"], "MANAGER");
}
