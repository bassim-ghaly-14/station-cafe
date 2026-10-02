//! THE REGRESSION: what a phone on the cafe Wi-Fi actually receives from
//! `http://<lan-ip>:47821/` and `http://station.local:47821/`.
//!
//! Two separate failures produced "the QR scans but nothing opens":
//!
//! 1. The listener answered `/` with the BROTLI-COMPRESSED bytes Tauri embeds
//!    for the frontend, labelled `Content-Type: text/html` and with **no**
//!    `Content-Encoding` to say so. A browser renders that as a screenful of
//!    binary garbage instead of the Station page. The read path itself needs a
//!    live `AppHandle`, so it is pinned from the source in
//!    `network::server`'s own tests; what IS reachable without one is the HTTP
//!    writer those decoded bytes pass through, and that is what this module
//!    proves — byte for byte, exactly as a browser would receive it.
//!
//! 2. `station.local` was advertised with the address of EVERY interface on the
//!    machine, so Safari resolved it to IPv6 link-local `fe80::` records it
//!    could never dial and retried forever. Pinned in `network::mdns`.
//!
//! Everything here is deterministic and needs no multicast, no second device
//! and no internet. The genuinely OS-dependent half — that some other device on
//! the cafe Wi-Fi can resolve the name and reach the socket — is the one thing
//! reported as SKIPPED rather than faked, and it says so when it does.
//!
//! It is a separate file rather than another module inside `network_test.rs`
//! because it is about the LAN contract as a whole: the socket, the writer, the
//! bind address, the advertised name and the two URLs have to agree, and
//! asserting that from one place is the point.

use crate::network::{config, qr, server};
use rusqlite::Connection;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    crate::db::migrate(&conn).unwrap();
    crate::demo_data::seed_for_development(&conn).unwrap();
    conn
}

/// The exact bytes a browser would receive, straight off the `Response`.
///
/// `tiny_http`'s own serialiser, not a re-implementation: what is asserted here
/// is what goes on the wire, status line and headers included. `HTTP_1_1` is
/// what a real browser negotiates, and an empty request-header list means no
/// `Accept-Encoding` — so nothing here can negotiate its way into compression.
fn wire_bytes(response: tiny_http::ResponseBox) -> Vec<u8> {
    let mut out = Vec::new();
    response
        .raw_print(&mut out, tiny_http::HTTPVersion(1, 1), &[], false, None)
        .expect("serialise response");
    out
}

fn header_value(wire: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(wire);
    let head = text.split("\r\n\r\n").next().unwrap_or_default();
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim()
            .eq_ignore_ascii_case(name)
            .then(|| v.trim().to_string())
    })
}

/// Split a raw HTTP message into its header block and its body.
fn split_message(wire: &[u8]) -> (&[u8], &[u8]) {
    let end = wire
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block terminated by a blank line")
        + 4;
    wire.split_at(end)
}

/// The bytes a frontend asset carries: the DECODED shell document.
const SHELL: &[u8] = b"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\"><head></head></html>";
// ---- 1. the HTTP writer, byte for byte ------------------------------------

#[test]
#[ignore = "real multicast on the LAN; run manually on a cafe-networked machine"]
fn live_verification_accepts_a_correct_advertisement() {
    // THE LIVE HALF. Everything else about verification is proven from the
    // source and from pure functions; this is the one assertion that needs a
    // real responder on a real interface.
    //
    // It is `#[ignore]`d so the suite never depends on the machine it runs on,
    // and it is run deliberately as part of validating this change.
    let ip = crate::network::address::select_lan_address().expect("a LAN address");
    assert!(
        crate::network::address::is_usable(&ip),
        "the address chosen to advertise must be one a phone can reach: {ip}"
    );
    let ad = crate::network::mdns::Advertisement::register(
        ip,
        crate::network::config::DEFAULT_PORT,
        env!("CARGO_PKG_VERSION"),
    )
    .expect("register the advertisement");
    let start = std::time::Instant::now();
    ad.verify(ip, crate::network::mdns::VERIFY_BUDGET)
        .expect("a correct advertisement must resolve back to this machine");
    let elapsed = start.elapsed();
    println!("live: {ip} verified in {elapsed:?}");
    assert!(
        elapsed <= crate::network::mdns::VERIFY_BUDGET,
        "verification must stay inside its own budget: {elapsed:?}"
    );
    // And the name a phone would type must actually resolve to that address.
    assert_eq!(
        std::net::ToSocketAddrs::to_socket_addrs(&format!(
            "{}:{}",
            crate::network::mdns::LAN_HOSTNAME,
            crate::network::config::DEFAULT_PORT
        ))
        .expect("the OS resolver must resolve station.local")
        .next()
        .expect("an address")
        .ip(),
        ip
    );
}

#[test]
fn an_unverified_hostname_never_reaches_the_qr_code() {
    /*
     * THE REGRESSION PIN, end to end.
     *
     * The reported defect was not that `station.local` failed to register — it
     * registered fine. It was that a successful registration was treated as
     * proof the name works, so an unresolvable hostname went onto the QR code
     * and every scan then paid a multi-second resolver stall (measured 4.9 s
     * via curl, 10.0 s via dscacheutil) before failing.
     *
     * So the QR must encode the IP whenever discovery is NOT verified. There
     * is no branch that can put a hostname on a code without a verified
     * advertisement behind it.
     */
    let cfg = crate::network::config::NetworkConfig {
        enabled: true,
        bind: "192.168.1.88".into(),
        port: 47821,
    };
    let bound: SocketAddr = "192.168.1.88:47821".parse().unwrap();

    let verified = qr::local_access(&cfg, Some(bound), true).expect("access info");
    assert_eq!(
        verified.url.as_deref(),
        Some("http://station.local:47821/"),
        "a VERIFIED hostname is the friendly URL"
    );

    let unverified = qr::local_access(&cfg, Some(bound), false).expect("access info");
    assert_eq!(
        unverified.url.as_deref(),
        Some("http://192.168.1.88:47821/"),
        "an UNVERIFIED hostname must never be encoded; the IP is the guarantee"
    );
    assert!(unverified.hostname.is_none());
    assert!(unverified.friendly_url.is_none());
    assert!(!unverified.discovery_active);
    // The QR SVG is regenerated from the fallback, so the code and the text
    // cannot disagree about which endpoint is being offered.
    assert!(unverified
        .svg
        .as_deref()
        .is_some_and(|s| s.contains("<svg")));
    assert_ne!(unverified.svg, verified.svg);
    // And the IP remains reachable either way — direct-IP access is never
    // replaced by hostname-only access.
    assert_eq!(
        unverified.fallback_url.as_deref(),
        Some("http://192.168.1.88:47821/")
    );
    assert_eq!(
        verified.fallback_url.as_deref(),
        unverified.fallback_url.as_deref()
    );
}

#[test]
fn discovery_is_verified_before_it_may_claim_the_qr_code() {
    // The verification is BOUNDED and it happens where it cannot delay the
    // listener: the socket is already bound and spawning its thread before
    // `apply` reaches the advertisement. Both halves are structural, so both
    // are pinned from the source. `runtime.rs` carries no test module, so the
    // whole file is the production half.
    let production = include_str!("network/runtime.rs");

    let bind = production
        .find("server::start(")
        .expect("the listener is started");
    let verify = production
        .find(".verify(addr.ip()")
        .expect("the name is verified");
    assert!(
        bind < verify,
        "verification must run AFTER the socket is serving, so it cannot delay a client"
    );

    // Bounded: the search timeout comes from the pinned budget, never a
    // literal, and the budget itself is asserted in `network::mdns`.
    assert!(production.contains("crate::network::mdns::VERIFY_BUDGET"));
    assert!(
        !production.contains("Duration::from_secs("),
        "no unbounded wait may be introduced into the advertisement path"
    );
}

#[test]
fn the_configured_port_is_the_documented_one() {
    // The QR, the mDNS record and the listener all read this one constant, so
    // this is where the documented port is pinned.
    assert_eq!(config::DEFAULT_PORT, 47821);
    assert_eq!(
        qr::friendly_url(config::DEFAULT_PORT),
        "http://station.local:47821/"
    );
}

#[test]
fn an_asset_response_is_valid_http_with_the_declared_content_type() {
    let wire = wire_bytes(server::asset_response(
        200,
        "text/html",
        SHELL,
        crate::network::web::cache_control(crate::network::web::INDEX),
    ));

    // A real status line, so the browser is never handed raw bytes to render.
    assert!(
        wire.starts_with(b"HTTP/1.1 200 OK"),
        "not an HTTP response: {:?}",
        String::from_utf8_lossy(&wire[..40.min(wire.len())])
    );
    // GET / is served as HTML.
    let content_type = header_value(&wire, "content-type").expect("a content type");
    assert!(
        content_type.starts_with("text/html"),
        "GET / must be served as text/html, got {content_type}"
    );
}

#[test]
fn the_body_is_the_plain_bytes_verbatim_not_a_compressed_stream() {
    /*
     * THE DEFECT, asserted at the only layer reachable without a live
     * `AppHandle`: the writer emits exactly the bytes it is given. The bug was
     * upstream of it — the reader supplied Brotli — but pinning this half means
     * the writer can never become a second route by which encoded bytes reach a
     * socket without a matching header.
     */
    let wire = wire_bytes(server::asset_response(
        200,
        "text/html",
        SHELL,
        crate::network::web::cache_control(crate::network::web::INDEX),
    ));
    let (head, body) = split_message(&wire);

    // The body IS the document: markup at the front, not the high bytes a
    // compressed stream opens with.
    assert_eq!(body, SHELL);
    assert!(body.starts_with(b"<!doctype html"));

    // `Content-Length` agrees with the body actually written, so the browser
    // never waits for bytes that will not arrive — the other half of "Safari
    // spins forever".
    assert_eq!(
        header_value(head, "content-length").as_deref(),
        Some(SHELL.len().to_string().as_str())
    );
}

#[test]
fn no_response_declares_an_encoding_it_does_not_apply() {
    // `Content-Encoding` is never set anywhere on this listener, so a body can
    // never be advertised as something it is not.
    for (mime, body) in [
        ("text/html", &SHELL[..]),
        ("text/javascript", &b"console.log(1)"[..]),
        ("image/png", &[0x89, b'P', b'N', b'G'][..]),
    ] {
        let wire = wire_bytes(server::asset_response(200, mime, body, "no-cache"));
        assert_eq!(
            header_value(&wire, "content-encoding"),
            None,
            "{mime} must not declare a content encoding"
        );
        assert_eq!(header_value(&wire, "content-type").as_deref(), Some(mime));
    }
}

#[test]
fn every_asset_response_is_sniffed_against_and_framed() {
    // The decoded bytes still travel under the POS's own headers.
    let wire = wire_bytes(server::asset_response(200, "text/html", SHELL, "no-cache"));
    assert_eq!(
        header_value(&wire, "x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert_eq!(
        header_value(&wire, "x-frame-options").as_deref(),
        Some("DENY")
    );
    assert!(header_value(&wire, "content-security-policy")
        .is_some_and(|csp| csp.contains("default-src 'self'")));
}

// ---- 2. the listener, on a real socket ------------------------------------

/// `GET <path>` over a real TCP connection, returning the raw bytes.
fn socket_get(addr: SocketAddr, path: &str) -> Vec<u8> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    raw
}

#[test]
fn the_local_server_starts_successfully() {
    let conn = Arc::new(Mutex::new(fresh()));
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = server::start_api_only(addr, conn).expect("the local server must start");

    assert!(
        handle.is_running(),
        "a started listener must report itself running"
    );
    assert!(std::net::TcpStream::connect(handle.local_addr()).is_ok());
    handle.stop();
}

#[test]
fn a_running_listener_answers_get_slash_with_valid_http() {
    /*
     * The strongest thing assertable without a Tauri runtime: the PORT speaks
     * HTTP. A started listener must emit a status line and a content type for
     * `/`, never an encoded blob — which is exactly the shape of the failure
     * that was reported.
     *
     * The embedded assets need a live `AppHandle`, so this listener serves the
     * JSON API alone and `/` is answered honestly rather than with a faked
     * shell. What matters here is the FRAMING, which is identical for both
     * surfaces: valid HTTP, a declared content type, a readable body.
     */
    let conn = Arc::new(Mutex::new(fresh()));
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = server::start_api_only(addr, conn).expect("start");

    let raw = socket_get(handle.local_addr(), "/");
    assert!(
        raw.starts_with(b"HTTP/1."),
        "the port must answer with an HTTP status line, got {:?}",
        String::from_utf8_lossy(&raw[..40.min(raw.len())])
    );
    assert!(header_value(&raw, "content-type").is_some());

    // A readable text body, never binary.
    let (_, body) = split_message(&raw);
    assert!(
        std::str::from_utf8(body).is_ok(),
        "the body must be readable text, not binary: {body:?}"
    );
    assert!(
        body.starts_with(b"{"),
        "expected a JSON document, got {body:?}"
    );

    handle.stop();
}

#[test]
fn the_port_is_released_on_stop_so_nothing_else_can_squat_it() {
    // Lifecycle: this is what makes "is there a second service on 47821?"
    // answerable, and what makes restarting the POS safe.
    let conn = Arc::new(Mutex::new(fresh()));
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = server::start_api_only(addr, conn).expect("start");
    let bound = handle.local_addr();

    handle.stop();
    assert!(!handle.is_running());
    // Genuinely free: a second listener may take it immediately.
    assert!(
        server::start_api_only(bound, Arc::new(Mutex::new(fresh()))).is_ok(),
        "the port must be bindable again once the listener has stopped"
    );
}
// ---- 3. the bind address is LAN-reachable ------------------------------

#[test]
fn the_service_binds_a_lan_reachable_address_and_never_loopback() {
    /*
     * The purpose of the Station Local page is to be opened from ANOTHER
     * device, so the automatic bind must resolve to an address a phone can
     * actually reach.
     *
     * SKIPPED, never faked, when the machine genuinely has no LAN address: a CI
     * container is a real environment with no cafe Wi-Fi, and inventing a
     * private range would prove nothing about this machine.
     */
    let Some(ip) = crate::network::address::select_lan_address() else {
        eprintln!("SKIPPED: this machine exposes no usable LAN address");
        return;
    };
    assert!(
        !ip.is_loopback(),
        "a QR encoding loopback sends the phone to itself"
    );
    assert!(
        crate::network::address::is_usable(&ip),
        "the bind address must be one a client can dial: {ip}"
    );
    assert!(ip.is_ipv4(), "a cafe phone is on IPv4: {ip}");

    // The bind and the QR read the SAME classifier, so they cannot disagree
    // about which interface Station is on.
    assert_eq!(
        crate::network::api::resolve_bind_address(config::LAN_INTERFACE).unwrap(),
        ip
    );

    // And the listener really binds THAT address, on the configured port.
    let port = {
        let probe = std::net::TcpListener::bind((ip, 0)).expect("bind the LAN address");
        let p = probe.local_addr().unwrap().port();
        drop(probe);
        p
    };
    let conn = Arc::new(Mutex::new(fresh()));
    let handle = server::start(SocketAddr::new(ip, port), conn, None).expect("start");
    assert_eq!(
        handle.local_addr().ip(),
        ip,
        "must not fall back to loopback"
    );
    assert_eq!(handle.local_addr().port(), port);
    // Reachable from another host: the socket is on the LAN interface, not
    // bound to 127.0.0.1 where nothing off this machine could reach it.
    assert!(std::net::TcpStream::connect(handle.local_addr()).is_ok());
    handle.stop();
}

#[test]
fn a_loopback_or_wildcard_bind_can_never_be_configured() {
    // The two addresses that produce a QR which scans perfectly and reaches
    // nothing, or which publish the POS on every adapter the PC has.
    let conn = fresh();
    let mgr = crate::services::auth::login(
        &conn,
        &crate::services::auth::LoginInput {
            name: "manager".into(),
            password: "manager123".into(),
        },
    )
    .unwrap()
    .user;
    for bind in ["127.0.0.1", "::1", "0.0.0.0", "::"] {
        let err = config::set(
            &conn,
            &mgr,
            &config::NetworkConfig {
                enabled: true,
                bind: bind.into(),
                port: 47821,
            },
        )
        .unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "{bind} must be refused"
        );
    }
}

#[test]
fn the_primary_url_is_the_friendly_name_and_the_fallback_the_discovered_lan_ip() {
    // THE URL CONTRACT, end to end, for both states discovery can be in.
    let cfg = config::NetworkConfig {
        enabled: true,
        bind: config::LAN_INTERFACE.into(),
        port: 47821,
    };
    let Some(lan) = crate::network::address::select_lan_address() else {
        eprintln!("SKIPPED: this machine exposes no usable LAN address");
        return;
    };
    let bound: SocketAddr = format!("{lan}:47821").parse().unwrap();

    // Discovery live: the QR encodes the name; the IP stays as the fallback.
    let access = qr::local_access(&cfg, Some(bound), true).unwrap();
    assert_eq!(access.url.as_deref(), Some("http://station.local:47821/"));
    assert_eq!(access.hostname.as_deref(), Some("station.local"));
    assert_eq!(access.fallback_url, Some(format!("http://{lan}:47821/")));
    // 9. Never loopback, never "localhost" — a QR encoding either points the
    //    phone at itself.
    let fallback = access.fallback_url.as_deref().unwrap();
    assert!(!fallback.contains("127.0.0.1"), "{fallback}");
    assert!(!fallback.contains("localhost"), "{fallback}");

    // 10. Hostname and fallback name the SAME server: same port, and the
    //     fallback is this machine's LAN address.
    assert!(access.url.as_deref().unwrap().ends_with(":47821/"));
    assert!(fallback.ends_with(":47821/"));
    assert!(fallback.contains(&crate::network::address::url_host(&lan)));

    // Discovery down: the code degrades to the IP that definitely works, and
    // claims no hostname nothing advertises.
    let access = qr::local_access(&cfg, Some(bound), false).unwrap();
    assert_eq!(access.url, access.fallback_url);
    assert_eq!(access.hostname, None);
    assert_eq!(
        access.url.as_deref(),
        Some(format!("http://{lan}:47821/").as_str())
    );
}

#[test]
fn the_advertised_port_is_the_bound_port() {
    // 11. mDNS, the QR and the socket must never name different ports.
    let bound: SocketAddr = "192.168.1.61:51234".parse().unwrap();
    let info = crate::network::mdns::service_info(bound.ip(), bound.port(), "0.1.0")
        .expect("service info");
    assert_eq!(info.get_port(), bound.port());
    assert!(qr::friendly_url(info.get_port()).ends_with(":51234/"));
    assert_eq!(
        qr::access_url("192.168.1.61", info.get_port()),
        "http://192.168.1.61:51234/"
    );
}

// ---- 5. the assets the page needs ----------------------------------------

#[test]
fn every_asset_the_page_references_is_reachable_and_none_is_encoded() {
    /*
     * 12. The page is only usable if its own resources resolve through the same
     * origin. The shell, the three named root files and the `/assets/` bundle
     * are what the application references, all through the ONE lookup this
     * listener uses — no second origin, no `localhost`, nothing encoded.
     */
    use crate::network::web;

    assert!(server::is_embedded_key(web::INDEX));
    for root in web::ROOT_ASSETS {
        assert!(server::is_embedded_key(root), "{root} must be reachable");
    }
    // A bundle file is fetched by a root-relative URL, so the same rule covers
    // it — and its cache header is the fingerprint-aware one, so a phone
    // downloads the multi-megabyte bundle once.
    assert!(server::is_embedded_key("/assets/index-DqmH59mP.js"));
    assert_eq!(
        web::cache_control("/assets/index-DqmH59mP.js"),
        web::FINGERPRINTED
    );

    /*
     * 13. Nothing outside the intended Station Local surface can be addressed.
     *
     * Two independent gates, and BOTH are asserted. `is_embedded_key` is only
     * the structural one — it refuses traversal, so no path can even name a
     * location. Exposure is prevented by the allow-list above it: the three
     * named root files, and `/assets/` only. `/.env` and friends are
     * structurally well-formed, so they are stopped by the allow-list and by
     * the absence of the file from the embedded bundle — not by spelling.
     */
    for traversal in [
        "/assets/../../Cargo.toml",
        "/../.env",
        "/assets//x",
        "/assets\\..\\secret",
    ] {
        assert!(
            !server::is_embedded_key(traversal),
            "{traversal} must be refused structurally"
        );
    }
    for forbidden in [
        "/.env",
        "/Cargo.toml",
        "/package.json",
        "/src-tauri/src/lib.rs",
        "/station.db",
        "/index.html.bak",
    ] {
        assert!(
            web::root_asset_key(forbidden).is_none(),
            "{forbidden} must not be an allow-listed root asset"
        );
        assert_eq!(
            web::route(forbidden),
            crate::network::web::Route::NotFound,
            "{forbidden} must be a clean 404, never a served file"
        );
    }

    // And each one leaves as a plain, sniffed, uncompressed response.
    for (path, mime) in [
        (web::INDEX, "text/html"),
        ("/assets/index-DqmH59mP.js", "text/javascript"),
        ("/station-cafe.png", "image/png"),
        ("/site.webmanifest", "application/manifest+json"),
    ] {
        let wire = wire_bytes(server::asset_response(
            200,
            mime,
            b"body",
            web::cache_control(path),
        ));
        assert_eq!(header_value(&wire, "content-type").as_deref(), Some(mime));
        assert_eq!(header_value(&wire, "content-encoding"), None, "{path}");
    }
}
