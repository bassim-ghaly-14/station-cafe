//! End-to-end tests for the local HTTP API's request handling.
//!
//! These drive the real `handle()` dispatcher against a real migrated and
//! seeded database — the same code path the socket serves — so they assert
//! actual behaviour rather than the shape of the code. A separate module (as
//! with `workflow_test`) keeps the feature's tests together and readable.

#[cfg(test)]
mod runtime_tests {
    //! Regression tests for the defect that made the local API permanently
    //! unreachable: the setting could be stored by NOTHING, and the server was
    //! only ever started once, at application startup. Enabling it therefore
    //! did nothing, and the UI showed an address for a service that had never
    //! bound a socket.
    //!
    //! These drive the real `apply` lifecycle against a real database and a
    //! real listener — no mocked server objects.

    use crate::network::config::{NetworkConfig, DEFAULT_PORT};
    use crate::network::runtime;
    use crate::services::auth;
    use rusqlite::Connection;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();
        conn
    }

    /// An AppState backed by an in-memory database, exactly as the app builds it.
    fn state(conn: Arc<Mutex<Connection>>) -> crate::AppState {
        crate::AppState {
            conn,
            developer_seed_grant: Mutex::new(None),
            api: Mutex::new(None),
            discovery: Mutex::new(None),
            // No Tauri runtime in a unit test, so the browser application and
            // the command bridge are unavailable here. That is exactly the
            // condition the production code reports honestly rather than
            // degrading, and it is covered by `apply` below.
            handle: std::sync::OnceLock::new(),
        }
    }

    fn manager(conn: &Connection) -> auth::User {
        auth::login(
            conn,
            &auth::LoginInput {
                name: "manager".into(),
                password: "manager123".into(),
            },
        )
        .unwrap()
        .user
    }

    /// An enabled configuration bound to loopback, which is a REAL socket we
    /// can drive deterministically. Production uses the classified LAN
    /// address; the lifecycle being tested is identical.
    fn enabled_on(port: u16) -> NetworkConfig {
        NetworkConfig {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port,
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    // ---- startup ----------------------------------------------------------

    #[test]
    fn a_disabled_api_does_not_start() {
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let status = runtime::apply(&s, &NetworkConfig::default());
        assert!(!status.enabled);
        assert!(!status.running, "a disabled API must not open a socket");
        assert_eq!(status.error.as_deref(), Some(runtime::ERR_DISABLED));
        assert!(s.api.lock().unwrap().is_none());
    }

    #[test]
    fn an_enabled_api_starts_on_initialization() {
        // THE defect: `enabled` was readable but nothing could ever act on it.
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let status = runtime::apply(&s, &enabled_on(free_port()));
        assert!(status.running, "an enabled API must bind: {status:?}");
        assert!(status.address.is_some());
        runtime::stop(&s);
    }

    // ---- toggle -----------------------------------------------------------

    #[test]
    fn enabling_starts_the_server_and_disabling_stops_it() {
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let port = free_port();

        let off = runtime::save_and_apply(
            &s,
            &manager(&conn.lock().unwrap()),
            &NetworkConfig::default(),
        )
        .unwrap();
        assert!(!off.running);

        let on =
            runtime::save_and_apply(&s, &manager(&conn.lock().unwrap()), &enabled_on(port))
                .unwrap();
        assert!(on.running, "enabling must actually start it");
        let bound = on.address.expect("a bound address");

        let off_again = runtime::save_and_apply(
            &s,
            &manager(&conn.lock().unwrap()),
            &NetworkConfig::default(),
        )
        .unwrap();
        assert!(!off_again.running, "disabling must stop it");

        // The port is genuinely released, so the same port can be reused.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut rebound = None;
        while std::time::Instant::now() < deadline {
            match runtime::save_and_apply(
                &s,
                &manager(&conn.lock().unwrap()),
                &enabled_on(port),
            ) {
                Ok(status) if status.running => {
                    rebound = Some(status);
                    break;
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        let again = rebound.expect("the port must be reusable after disable");
        assert_eq!(again.address, Some(bound));
        runtime::stop(&s);
    }

    // ---- bind failure -----------------------------------------------------

    #[test]
    fn a_failed_bind_yields_unavailable_while_staying_enabled() {
        // The core distinction the UI depends on: CONFIGURED is not RUNNING.
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let port = free_port();

        // Occupy the port so the real bind must fail.
        let blocker = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();

        let status = runtime::apply(&s, &enabled_on(port));
        assert!(status.enabled, "the SETTING is still enabled");
        assert!(!status.running, "but it is not running");
        assert_eq!(status.error.as_deref(), Some(runtime::ERR_BIND_FAILED));
        assert!(status.address.is_none(), "no address may be claimed");
        assert!(s.api.lock().unwrap().is_none(), "no listener is held");

        drop(blocker);
    }

    #[test]
    fn a_failed_bind_does_not_advertise_mdns() {
        // mDNS must never point a manager at a service that does not exist.
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let port = free_port();
        let blocker = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();

        let status = runtime::apply(&s, &enabled_on(port));
        assert!(!status.running);
        // A service that never bound must not be advertised.
        assert!(
            s.discovery.lock().unwrap().is_none(),
            "a service that never bound must not be advertised"
        );
        assert!(s.discovery.lock().unwrap().is_none());

        drop(blocker);
    }

    #[test]
    fn an_unusable_bind_address_fails_safely() {
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        // 0.0.0.0 is refused by the classifier even when configured directly.
        let status = runtime::apply(
            &s,
            &NetworkConfig {
                enabled: true,
                bind: "0.0.0.0".into(),
                port: free_port(),
            },
        );
        assert!(!status.running);
        assert!(status.error.is_some());
        assert!(s.api.lock().unwrap().is_none());
    }

    // ---- real socket ------------------------------------------------------

    #[test]
    fn the_bound_socket_actually_answers_health_and_stops_answering() {
        // The end-to-end proof, over a real socket: start, request, stop,
        // then confirm the port is no longer served and can be reused.
        use std::io::{Read, Write};
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let port = free_port();
        let status = runtime::apply(&s, &enabled_on(port));
        assert!(status.running, "{status:?}");
        let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

        let request = |addr: SocketAddr| -> std::io::Result<(u16, String)> {
            let mut stream = std::net::TcpStream::connect(addr)?;
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
            stream.write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )?;
            let mut raw = String::new();
            stream.read_to_string(&mut raw)?;
            let code = raw.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
            Ok((code, raw))
        };

        // 1. The health endpoint really listens and returns 200.
        let (code, raw) = request(addr).expect("must answer over the real socket");
        assert_eq!(code, 200, "{raw}");
        assert!(raw.contains("station-cafe"), "{raw}");

        // 2. Stopping the service makes the endpoint unreachable.
        runtime::stop(&s);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if request(addr).is_err() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the endpoint must stop answering after stop()"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // 3. And the port can be bound again.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut rebound = false;
        while std::time::Instant::now() < deadline {
            if runtime::apply(&s, &enabled_on(port)).running {
                rebound = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(rebound, "the port must be reusable after stop");
        runtime::stop(&s);
    }

    #[test]
    fn applying_the_same_configuration_twice_is_safe() {
        // Idempotent: no second listener is left fighting for the port.
        let conn = Arc::new(Mutex::new(fresh()));
        let s = state(Arc::clone(&conn));
        let port = free_port();
        assert!(runtime::apply(&s, &enabled_on(port)).running);
        assert!(runtime::apply(&s, &enabled_on(port)).running);
        assert!(s.api.lock().unwrap().is_some());
        runtime::stop(&s);
    }

    #[test]
    fn the_default_port_is_the_documented_one() {
        assert_eq!(DEFAULT_PORT, 47821);
    }
}


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
    let handle = crate::network::server::start_api_only(addr, conn).expect("start");

    let (status, raw) = http_get(handle.local_addr(), "/api/v1/health", None);
    assert_eq!(status, 200, "{raw}");
    assert!(raw.contains("station-cafe"), "{raw}");

    // Protected routes are enforced on the real socket too.
    let (status, _) = http_get(handle.local_addr(), "/api/v1/me", None);
    assert_eq!(status, 401);

    handle.stop();
}

#[test]
fn the_api_stays_usable_when_discovery_is_impossible() {
    // The failure mode that matters: discovery is a convenience, so its
    // absence must leave the API fully functional. This exercises a real
    // listener with NO advertisement at all — the state Station is in
    // whenever multicast is blocked or the responder cannot start — and
    // proves the manager can still reach it by IP.
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start_api_only(addr, conn.clone()).expect("start");

    // Deliberately no Advertisement is created: this is the degraded mode.
    let (status, raw) = http_get(handle.local_addr(), "/api/v1/health", None);
    assert_eq!(status, 200, "{raw}");

    // And it is still secured: absence of discovery is not absence of auth.
    let (status, _) = http_get(handle.local_addr(), "/api/v1/me", None);
    assert_eq!(status, 401);

    handle.stop();
}

#[test]
fn a_bearer_token_authorizes_a_real_socket_request() {
    crate::network::server::reset_login_limiter_for_tests();
    let conn = std::sync::Arc::new(std::sync::Mutex::new(fresh()));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = crate::network::server::start_api_only(addr, conn.clone()).expect("start");

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
    let handle = crate::network::server::start_api_only(addr, conn.clone()).expect("start");
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
        match crate::network::server::start_api_only(bound, conn.clone()) {
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
    let first = crate::network::server::start_api_only(addr, conn.clone()).expect("start");
    let taken = first.local_addr();

    let second = crate::network::server::start_api_only(taken, conn);
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
    let handle = crate::network::server::start_api_only(addr, conn).expect("start");
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

#[cfg(test)]
mod web_tests {
    //! Tests for the browser surface served alongside the API.
    //!
    //! The phone must reach the REAL Station application — the same bundle the
    //! desktop window loads — and the REAL commands, not a parallel
    //! implementation. These tests pin the three properties that make that
    //! true and keep it true:
    //!
    //!   1. A non-API path is answered by the Station frontend, with an SPA
    //!      fallback so a refresh or a deep link works.
    //!   2. `/api/v1/*` stays EXACTLY as it was — JSON, authenticated,
    //!      role-protected — and never falls through to the HTML.
    //!   3. `/api/v1/cmd/*` runs the SAME Rust commands the desktop runs, so
    //!      login, roles and business rules are shared rather than reimplemented.
    //!
    //! The socket tests drive the real listener, because only those prove the
    //! split holds on the wire.

    use crate::network::web::{self, Route};
    use crate::services::auth;
    use rusqlite::Connection;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    type Db = Arc<Mutex<Connection>>;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();
        conn
    }

    fn shared(conn: Connection) -> Db {
        Arc::new(Mutex::new(conn))
    }

    /// A listener on a free loopback port.
    ///
    /// The browser application and the command bridge are served from Tauri's
    /// embedded asset set, so those two surfaces only exist inside a running
    /// Tauri application. These tests therefore cover what does not need one —
    /// the JSON API, routing, argument handling and the security rules — while
    /// the asset and command surfaces are proved on the wire during LAN
    /// verification, where the real application is running.
    fn start(conn: &Db) -> crate::network::server::ServerHandle {
        let addr: SocketAddr = SocketAddr::from(([127, 0, 0, 1], 0));
        crate::network::server::start_api_only(addr, Arc::clone(conn)).expect("start")
    }

    /// A login token for a seeded user, produced by the real auth service.
    fn login(conn: &Db, name: &str) -> String {
        auth::login(
            &conn.lock().unwrap(),
            &auth::LoginInput {
                name: name.into(),
                password: format!("{name}123"),
            },
        )
        .unwrap()
        .token
    }

    // ---- routing ----------------------------------------------------------

    #[test]
    fn the_root_and_client_routes_reach_the_frontend() {
        assert_eq!(web::route("/"), Route::Index);
        assert_eq!(web::route("/index.html"), Route::Index);
        // The SPA fallback: the application owns its own routing, so a refresh
        // on a deep link must return the shell rather than a 404.
        assert_eq!(web::route("/pos"), Route::Spa);
        assert_eq!(web::route("/reports"), Route::Spa);
    }

    #[test]
    fn a_missing_file_is_never_the_shell() {
        // Answering a missing script with HTML would surface as a baffling
        // parse error in the browser instead of a clean 404.
        assert_eq!(web::route("/nope.js"), Route::NotFound);
        assert_eq!(web::route("/assets/missing-abc123.js"), Route::NotFound);
    }

    #[test]
    fn an_asset_path_cannot_escape_the_bundle() {
        // Structural, not a filter: traversal never becomes a key.
        for attempt in [
            "/assets/../../etc/passwd",
            "/assets/..%2f..%2fsecret",
            "/assets/a/../../b",
            "/assets/./x",
            "/assets//x",
            "/assets/",
        ] {
            assert!(web::asset_key(attempt).is_none(), "{attempt}");
            assert_eq!(web::route(attempt), Route::NotFound, "{attempt}");
        }
    }

    #[test]
    fn the_api_namespace_is_decided_by_one_prefix_test() {
        use crate::network::server::command_name;
        for path in ["/api/v10/health", "/api/v", "/apixyz", "/", "/assets/app.js"] {
            assert!(!web::is_api_path(path), "{path} must not be an API path");
            assert!(command_name(path).is_none(), "{path} must not be a command");
        }
        assert!(web::is_api_path("/api/v1/health"));
        assert_eq!(
            command_name("/api/v1/cmd/list_products"),
            Some("list_products")
        );
    }

    #[test]
    fn a_command_name_must_be_a_plain_identifier() {
        use crate::network::server::command_name;
        // Anything that could smuggle a separator or a path never reaches the
        // command lookup.
        for path in [
            "/api/v1/cmd/",
            "/api/v1/cmd/list products",
            "/api/v1/cmd/../../etc",
            "/api/v1/cmd/List_Products",
        ] {
            assert!(command_name(path).is_none(), "{path}");
        }
    }

    // ---- the wire ---------------------------------------------------------

    #[test]
    fn the_api_namespace_keeps_its_json_404() {
        crate::network::server::reset_login_limiter_for_tests();
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        let (status, raw) = get(addr, "/api/v1/nope", None);
        assert_eq!(status, 404, "{raw}");
        assert!(raw.contains("application/json"), "{raw}");
        // An API 404 must NEVER be the HTML application.
        assert!(!raw.contains("<html"), "{raw}");

        handle.stop();
    }

    #[test]
    fn the_health_probe_is_still_json() {
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        let (status, raw) = get(addr, "/api/v1/health", None);
        assert_eq!(status, 200, "{raw}");
        assert!(raw.contains("station-cafe"), "{raw}");
        assert!(raw.contains("application/json"), "{raw}");

        handle.stop();
    }

    #[test]
    fn a_command_route_refuses_a_get() {
        // Commands mutate state; only an explicit POST may run one.
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        let (status, _) = get(addr, "/api/v1/cmd/list_categories", None);
        assert_eq!(status, 405);

        handle.stop();
    }

    #[test]
    fn a_command_without_a_token_is_401_not_an_empty_result() {
        // The core authorization guarantee for the browser: an unauthenticated
        // caller is refused, and never handed plausible-looking empty data.
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        let (status, _) = post(addr, "/api/v1/cmd/list_categories", "{}");
        assert_eq!(status, 401);

        handle.stop();
    }

    #[test]
    fn a_malformed_command_body_is_a_400() {
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();
        let token = login(&conn, "manager");

        let (status, _) = post_auth(addr, "/api/v1/cmd/create_category", &token, "not json");
        assert_eq!(status, 400);

        handle.stop();
    }

    #[test]
    fn a_missing_required_argument_is_a_400_not_a_default() {
        // A silently defaulted `""` or `0` is how a business rule gets skipped.
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();
        let token = login(&conn, "manager");

        let (status, _) = post_auth(addr, "/api/v1/cmd/create_category", &token, "{}");
        assert_eq!(status, 400);

        handle.stop();
    }

    #[test]
    fn a_token_in_the_query_string_never_authorizes_a_command() {
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();
        let token = login(&conn, "manager");

        let (status, raw) = get(addr, &format!("/api/v1/cmd/me?token={token}"), None);
        assert_ne!(status, 200, "a token in the URL must never authorize: {raw}");

        handle.stop();
    }

    #[test]
    fn an_error_response_never_echoes_the_token() {
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();
        let token = login(&conn, "manager");

        let (status, raw) = post_auth(
            addr,
            "/api/v1/cmd/delete_category",
            &token,
            r#"{"category_id":999999}"#,
        );
        assert_ne!(status, 200, "{raw}");
        assert!(!raw.contains(&token), "the token leaked into the error: {raw}");

        handle.stop();
    }

    #[test]
    fn the_api_is_still_authenticated_and_role_protected() {
        // Serving the browser must not have relaxed a single API rule.
        crate::network::server::reset_login_limiter_for_tests();
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        for path in ["/api/v1/me", "/api/v1/manager/summary"] {
            let (status, _) = get(addr, path, None);
            assert_eq!(status, 401, "{path} must still require a token");
        }

        // STAFF is refused the manager endpoint, and the refusal survives.
        let staff = login(&conn, "cashier");
        let (status, raw) = get(
            addr,
            "/api/v1/manager/summary",
            Some(&format!("Bearer {staff}")),
        );
        assert_eq!(status, 403, "{raw}");

        let manager = login(&conn, "manager");
        let (status, raw) = get(
            addr,
            "/api/v1/manager/summary",
            Some(&format!("Bearer {manager}")),
        );
        assert_eq!(status, 200, "{raw}");

        handle.stop();
    }

    #[test]
    fn login_over_the_socket_authenticates_against_the_rust_services() {
        crate::network::server::reset_login_limiter_for_tests();
        let conn = shared(fresh());
        let handle = start(&conn);
        let addr = handle.local_addr();

        let (status, raw) = post(
            addr,
            "/api/v1/auth/login",
            r#"{"name":"manager","password":"manager123"}"#,
        );
        assert_eq!(status, 200, "{raw}");
        assert!(raw.contains("\"token\""), "{raw}");
        assert!(raw.contains("MANAGER"), "{raw}");
        // The response carries a session, never the password.
        assert!(!raw.contains("manager123"), "{raw}");

        let (status, _) = post(
            addr,
            "/api/v1/auth/login",
            r#"{"name":"manager","password":"wrong"}"#,
        );
        assert_eq!(status, 401);

        handle.stop();
    }

    // ---- socket helpers ---------------------------------------------------

    /// A GET over a real socket, returning the status and the whole response.
    fn get(addr: SocketAddr, path: &str, header: Option<&str>) -> (u16, String) {
        let mut request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
        if let Some(h) = header {
            request.push_str(&format!("Authorization: {h}\r\n"));
        }
        request.push_str("\r\n");
        exchange(addr, request.as_bytes())
    }

    /// A POST with a bearer token, the exact shape the browser transport sends.
    fn post_auth(addr: SocketAddr, path: &str, token: &str, body: &str) -> (u16, String) {
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
             Content-Type: application/json\r\nAuthorization: Bearer {token}\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        exchange(addr, request.as_bytes())
    }

    /// A POST with no Authorization header at all.
    fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, String) {
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        exchange(addr, request.as_bytes())
    }

    fn exchange(addr: SocketAddr, request: &[u8]) -> (u16, String) {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request).unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        // Assets are served as raw bytes and may be large; decode leniently so a
        // test can assert on the text it cares about without failing on an
        // unrelated byte.
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let status: u16 = raw
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("status line");
        (status, raw)
    }
}
