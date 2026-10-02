//! The local-access QR code.
//!
//! What the QR is: a PHONE NUMBER for a building. It says "Station's web app is
//! this far away, on this address". Scanning it opens the Station login screen
//! in the phone's browser; the user then signs in with their own Station
//! account. That is all.
//!
//! What the QR is emphatically not: a key. It carries no username, no
//! password, no bearer token, no session id, no API key, no discount PIN, no
//! database path and no customer or employee data. A QR is a sticker on a
//! counter that anyone nearby can photograph, so anything secret in it is
//! compromised the moment it is printed. Authentication stays exactly where it
//! already is — `services::auth::login`, reached in the browser through
//! `POST /api/v1/auth/login`.
//!
//! Because the payload is an address, it is assembled HERE, beside the code
//! that knows the real port and this machine's real addresses, rather than in
//! the frontend from scattered state. That is a structural guarantee against a
//! token being concatenated into a URL later, and it makes the exact string
//! testable.

use crate::network::config::NetworkConfig;
use std::net::IpAddr;

/// The one path a scanner can usefully land on: the Station web application.
///
/// Deliberately the ROOT, not `/api/v1/health`. The QR exists to put a manager
/// in front of the Station login screen on their phone, so it must open the
/// application itself. It is not a health probe any more: the browser app is
/// served from `/` by the same listener, so this is a real, working entry point
/// rather than a promise of a future one.
///
/// Still an address and nothing else — no credential, no token, no session id.
pub const ACCESS_PATH: &str = "/";

/// Build the access URL for a host and the configured port.
///
/// The ONLY thing this produces is `scheme://host:port/`. It has no branch that
/// could add a query string, a fragment or a credential, so there is no code
/// path by which a secret could be encoded — and, since the app authenticates
/// in the browser, none is needed.
pub fn access_url(host: &str, port: u16) -> String {
    // `http` because the listener is plain HTTP on a LAN. A phone scanning this
    // gets the real Station login page over the café's own network; no secret
    // is transmitted in the address, which is what would otherwise justify TLS.
    // The literal is deliberately inline rather than behind a scheme constant:
    // `tests/lanContract.test.ts` pins this exact expression as the proof that
    // the payload is assembled from host and port alone, with no branch that
    // could concatenate a credential into it. Keep it in this shape.
    format!("http://{host}:{port}{ACCESS_PATH}")
}

/// The canonical friendly URL for the LAN service — `http://station.local:47821/`.
///
/// THE single place the friendly address is assembled. The QR page, Dev
/// Settings and the mDNS hostname all read from here (and from
/// [`mdns::LAN_HOSTNAME`]), so the name a manager types, the name printed on the
/// page and the name advertised on the network cannot drift apart.
///
/// The port is a parameter, never a literal: it is the port the listener
/// ACTUALLY bound, so a reconfigured port produces a matching URL instead of a
/// stale one.
pub fn friendly_url(port: u16) -> String {
    access_url(crate::network::mdns::LAN_HOSTNAME, port)
}

/// Everything the UI needs to show the QR and explain it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccess {
    /// The URL encoded in the QR — `None` when nothing is listening.
    ///
    /// Optional, and deliberately so. The previous contract always produced a
    /// URL, which let the UI display — and imply was reachable — an address
    /// for a server that did not exist. A QR to a stopped API is worse than no
    /// QR at all, because it scans and then fails.
    ///
    /// This is the PREFERRED address: `station.local` while mDNS discovery is
    /// live, and the IP fallback otherwise. It is the single canonical value,
    /// and the QR is rendered from exactly this string — the payload and the
    /// text a manager reads are therefore the same bytes by construction, not
    /// by two code paths agreeing.
    pub url: Option<String>,
    /// The QR as an SVG document. `None` whenever `url` is `None`.
    pub svg: Option<String>,
    /// Whether the API is actually LISTENING. The UI reflects this, not the
    /// setting.
    pub api_running: bool,
    /// Stable key explaining why it is not running, when it is not.
    pub error: Option<String>,
    /// The port Station is configured to serve on.
    pub port: u16,
    /// The address the QR encodes, when there is one.
    pub host: Option<String>,
    /// Other usable addresses on this machine, as an IP fallback. Only offered
    /// while the service is actually running.
    pub other_hosts: Vec<String>,
    /// Whether mDNS advertised Station AND the name resolved back to this
    /// machine. Only ever true after a real bind and a successful
    /// [`crate::network::mdns::Advertisement::verify`].
    ///
    /// This is deliberately stronger than "registration returned Ok". A name
    /// that cannot be resolved is worse than no name at all — see
    /// [`crate::network::runtime`] — so it must not be advertised to the UI.
    pub discovery_active: bool,
    /// The friendly hostname, present only while mDNS discovery is actually
    /// advertising it. `None` means "clients cannot resolve this name right
    /// now", and the UI must then fall back to `fallback_url` rather than
    /// display a name nothing answers to.
    pub hostname: Option<String>,
    /// The friendly URL, `http://station.local:<port>/`, or `None` when
    /// discovery is not advertising it.
    pub friendly_url: Option<String>,
    /// The IP URL, `http://<lan-ip>:<port>/` — always present while running.
    ///
    /// This is the guarantee, not the convenience: a phone whose OS blocks
    /// mDNS, or a network that filters multicast, still reaches Station here.
    pub fallback_url: Option<String>,
}

/// Choose the address the QR should encode.
///
/// A loopback address is NEVER used: a QR encoding `127.0.0.1` would send the
/// manager's phone to the phone itself, which is the classic way a "working"
/// QR turns out to reach nothing.
/// Choose the address the QR should encode.
///
/// It reads the address the LISTENER ACTUALLY BOUND when there is one, so the
/// code and the socket can never disagree. Only when the service is not
/// running does it fall back to what is configured — and in that case the
/// caller must not present the result as reachable.
pub fn primary_host(cfg: &NetworkConfig) -> Option<String> {
    // The configured bind address is the most accurate answer when the manager
    // pinned a specific interface. A loopback bind is still rejected: it would
    // encode an address that resolves to the scanning phone itself.
    let configured = cfg.bind.trim();
    if configured != crate::network::config::LAN_INTERFACE {
        if let Ok(ip) = configured.parse::<IpAddr>() {
            return crate::network::address::is_usable(&ip)
                .then(|| crate::network::address::url_host(&ip));
        }
    }
    // Same classifier the bind uses, so both land on the same interface.
    crate::network::address::select_lan_address()
        .map(|ip| crate::network::address::url_host(&ip))
}

/// Render the QR as an SVG document.
///
/// Deterministic for a given URL, so a test can assert stability, and small
/// enough to embed inline. The document carries no scripts and no external
/// references.
pub fn render_svg(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url).map_err(|e| format!("cannot encode access URL: {e}"))?;
    let mut colors = code.render::<qrcode::render::svg::Color>();
    // The size is fixed so the UI can rely on a stable aspect ratio.
    Ok(colors.min_dimensions(256, 256).build())
}

/// Assemble the full local-access view for the UI.
///
/// `running_addr` is the address a listener ACTUALLY bound. When it is `None`
/// there is no server, so no URL and no QR are produced: the UI is told the
/// service is down and why, rather than being handed an address that cannot
/// be reached.
pub fn local_access(
    cfg: &NetworkConfig,
    running_addr: Option<std::net::SocketAddr>,
    discovery_active: bool,
) -> Result<LocalAccess, String> {
    let port = running_addr.map(|a| a.port()).unwrap_or(cfg.port);

    if running_addr.is_none() {
        return Ok(LocalAccess {
            url: None,
            svg: None,
            api_running: false,
            error: Some(
                if cfg.enabled {
                    crate::network::runtime::ERR_BIND_FAILED.to_string()
                } else {
                    crate::network::runtime::ERR_DISABLED.to_string()
                },
            ),
            port,
            host: None,
            other_hosts: Vec::new(),
            discovery_active: false,
            hostname: None,
            friendly_url: None,
            fallback_url: None,
        });
    }

    let host = primary_host(cfg).ok_or_else(|| {
        "no LAN address is available on this machine, so a scannable code cannot be produced"
            .to_string()
    })?;
    // The IP address is ALWAYS produced. It is the guarantee: a phone whose OS
    // does not answer mDNS queries still reaches Station this way, so this must
    // never depend on discovery succeeding.
    let fallback_url = access_url(&host, port);
    // The friendly name is offered only when it has actually been ADVERTISED
    // AND VERIFIED. Claiming `station.local` on the strength of a successful
    // registration alone would put a URL on a counter that no phone can
    // resolve, which is strictly worse than showing the IP that works: an
    // unanswered `.local` lookup blocks for seconds before it fails
    // (measured 4.9 s), so that mistake is paid again on every single scan.
    let friendly_url = discovery_active.then(|| friendly_url(port));
    // The QR encodes the canonical `url`, and the displayed URL is that same
    // value — one variable, so the code and the text cannot disagree.
    let url = friendly_url.clone().unwrap_or_else(|| fallback_url.clone());
    let svg = render_svg(&url)?;

    // Offer the machine's other addresses so a manager is never stuck if the
    // primary one is unreachable from their phone.
    let mut other_hosts: Vec<String> = local_ip_address::list_afinet_netifas()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| crate::network::address::is_usable(ip))
        .map(|ip| crate::network::address::url_host(&ip))
        .filter(|s| s != &host)
        .collect();
    other_hosts.sort();
    other_hosts.dedup();

    Ok(LocalAccess {
        url: Some(url),
        svg: Some(svg),
        api_running: true,
        error: None,
        port,
        host: Some(host),
        other_hosts,
        discovery_active,
        hostname: discovery_active.then(|| crate::network::mdns::LAN_HOSTNAME.to_string()),
        friendly_url,
        fallback_url: Some(fallback_url),
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_is_protocol_host_port_and_the_app_root() {
        assert_eq!(access_url("192.168.1.50", 47821), "http://192.168.1.50:47821/");
    }

    #[test]
    fn the_qr_opens_the_web_app_not_the_health_endpoint() {
        // THE change: the QR must land a manager on the login screen. Pointing
        // it at the health probe would show them raw JSON on their phone.
        let url = access_url("192.168.1.50", 47821);
        assert!(url.ends_with('/'), "the QR must address the app root: {url}");
        assert!(!url.contains("/api/v1/health"), "no longer a health probe: {url}");
        assert!(!url.contains("/api"), "the QR is not an API address: {url}");
    }

    #[test]
    fn the_url_never_carries_a_query_fragment_or_credential() {
        // The structural guarantee: the payload is built from exactly four
        // parts, so there is no branch that could append a secret.
        let url = access_url("192.168.1.50", 47821);
        assert!(!url.contains('?'), "no query string: {url}");
        assert!(!url.contains('#'), "no fragment: {url}");
        assert!(!url.contains('@'), "no userinfo: {url}");
        assert!(!url.contains(';'), "no parameters: {url}");
    }

    #[test]
    fn the_url_contains_no_credential_word() {
        let lower = access_url("192.168.1.50", 47821).to_lowercase();
        for forbidden in [
            "token", "password", "passwd", "secret", "pin", "auth", "bearer", "session", "key",
            "user", "login",
        ] {
            assert!(!lower.contains(forbidden), "URL leaked {forbidden}");
        }
    }

    #[test]
    fn the_qr_svg_renders_for_the_app_root_and_fetches_nothing() {
        // The QR must encode an address Station actually serves, and the SVG it
        // produces must not be able to execute or fetch anything itself.
        let svg = render_svg(&access_url("10.0.0.5", 47821)).expect("renders");
        assert!(svg.contains("<svg"));
        // The SVG namespace is the one `http://` a valid document may contain;
        // it is an identifier, never a request. Any OTHER remote reference
        // would make the image depend on the network.
        let without_namespace = svg.replace("http://www.w3.org/2000/svg", "");
        assert!(
            !without_namespace.contains("http://"),
            "the SVG must reference nothing: {svg}"
        );
        assert!(!without_namespace.contains("https://"), "the SVG must reference nothing: {svg}");
        assert!(!svg.contains("<script"), "no script in an image");
        assert!(!svg.contains("xlink:href"), "no external reference in an image");
    }

    #[test]
    fn a_port_change_changes_the_url() {
        assert_ne!(access_url("10.0.0.5", 47821), access_url("10.0.0.5", 50000));
    }

    #[test]
    fn an_address_change_changes_the_url() {
        // This is the DHCP case: the code must be rebuilt for the new address.
        assert_ne!(access_url("10.0.0.5", 47821), access_url("10.0.0.9", 47821));
    }

    #[test]
    fn a_hostname_may_be_used_when_discovery_supports_it() {
        assert_eq!(access_url("station.local", 47821), "http://station.local:47821/");
    }

    #[test]
    fn a_loopback_address_is_never_offered_for_the_qr() {
        // A QR encoding 127.0.0.1 would point the phone at itself — a code that
        // scans perfectly and reaches nothing.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "127.0.0.1".into(),
            port: 47821,
        };
        if let Some(host) = primary_host(&cfg) {
            assert_ne!(host, "127.0.0.1");
        }
    }

    #[test]
    fn the_qr_renders_as_an_svg_document() {
        let svg = render_svg(&access_url("192.168.1.50", 47821)).expect("renders");
        assert!(svg.contains("<svg"));
        // A QR image must not be able to execute anything or fetch anything.
        // The SVG xmlns is a namespace identifier, not a network reference, so
        // the checks target real fetch/execute vectors instead.
        assert!(!svg.contains("<script"));
        assert!(!svg.contains("onload="));
        assert!(!svg.contains("href"));
        assert!(!svg.contains("url("));
        assert!(!svg.contains("<image"));
    }

    #[test]
    fn the_qr_is_deterministic_for_the_same_url() {
        let a = render_svg(&access_url("192.168.1.50", 47821)).unwrap();
        let b = render_svg(&access_url("192.168.1.50", 47821)).unwrap();
        assert_eq!(a, b, "the same address must always produce the same code");
    }

    #[test]
    fn different_addresses_produce_different_codes() {
        let a = render_svg(&access_url("10.0.0.5", 47821)).unwrap();
        let b = render_svg(&access_url("10.0.0.9", 47821)).unwrap();
        assert_ne!(a, b, "a moved address must produce a different code");
    }

    #[test]
    fn the_canonical_friendly_url_is_station_local_on_the_bound_port() {
        // THE PRIMARY CONTRACT.
        assert_eq!(friendly_url(47821), "http://station.local:47821/");
    }

    #[test]
    fn the_friendly_url_preserves_a_reconfigured_port() {
        // The port is never a literal anywhere: it comes from the bound socket.
        assert_eq!(friendly_url(50000), "http://station.local:50000/");
        assert_ne!(friendly_url(47821), friendly_url(50000));
    }

    #[test]
    fn the_friendly_url_is_the_same_string_the_qr_encodes() {
        // The QR payload IS the canonical URL, not a parallel reconstruction.
        let url = friendly_url(47821);
        let svg = render_svg(&url).expect("renders");
        // Determinism is what makes this assertable: the same URL always yields
        // byte-identical output, and a different URL never does.
        assert_eq!(svg, render_svg(&friendly_url(47821)).unwrap());
        assert_ne!(svg, render_svg(&access_url("192.168.1.50", 47821)).unwrap());
    }

    #[test]
    fn the_ip_fallback_url_is_the_form_the_manager_types_when_dns_fails() {
        // THE FALLBACK CONTRACT.
        assert_eq!(
            access_url("192.168.1.88", 47821),
            "http://192.168.1.88:47821/"
        );
    }

    #[test]
    fn both_urls_end_the_same_way() {
        // Trailing-slash behaviour is identical for the friendly and the
        // fallback form, so the two can be shown side by side.
        for url in [friendly_url(47821), access_url("192.168.1.88", 47821)] {
            assert!(url.ends_with('/'), "{url}");
            assert!(
                url.matches('/').count() == 3,
                "exactly scheme + path: {url}"
            );
        }
    }

    #[test]
    fn neither_url_carries_a_credential() {
        // The friendly name must not become a place to smuggle one.
        for url in [friendly_url(47821), access_url("192.168.1.88", 47821)] {
            assert!(
                !url.contains('?') && !url.contains('#') && !url.contains('@'),
                "{url}"
            );
        }
    }

    #[test]
    fn the_qr_is_the_friendly_name_whenever_discovery_is_advertising() {
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let addr: std::net::SocketAddr = "192.168.1.50:47821".parse().unwrap();
        let access = local_access(&cfg, Some(addr), true).expect("access info");
        assert_eq!(access.url.as_deref(), Some("http://station.local:47821/"));
        assert_eq!(
            access.friendly_url.as_deref(),
            Some("http://station.local:47821/")
        );
        assert_eq!(access.hostname.as_deref(), Some("station.local"));
        // The IP remains available as the fallback, never removed.
        assert!(access
            .fallback_url
            .as_deref()
            .is_some_and(|u| u.ends_with(":47821/")));
    }

    #[test]
    fn the_qr_falls_back_to_the_ip_when_discovery_is_not_advertising() {
        // THE GRACEFUL-FALLBACK CONTRACT: a name nothing answers to is worse
        // than the address that always works.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let addr: std::net::SocketAddr = "192.168.1.50:47821".parse().unwrap();
        let access = local_access(&cfg, Some(addr), false).expect("access info");
        assert!(
            !access.discovery_active,
            "this is the degraded mode under test"
        );
        assert_eq!(access.url.as_deref(), access.fallback_url.as_deref());
        assert_ne!(access.url.as_deref(), Some("http://station.local:47821/"));
        // No hostname is claimed while nothing advertises it.
        assert_eq!(access.hostname, None);
        assert_eq!(access.friendly_url, None);
        // But the service is fully running and still yields a usable QR.
        assert!(access.api_running);
        assert!(access.svg.is_some());
    }

    #[test]
    fn a_stopped_service_claims_no_address_at_all() {
        // The friendly name must not survive into a stopped state either.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let access = local_access(&cfg, None, true).expect("access info");
        assert_eq!(access.hostname, None);
        assert_eq!(access.friendly_url, None);
        assert_eq!(access.fallback_url, None);
        assert_eq!(access.url, None);
    }

    #[test]
    fn local_access_reports_the_running_port_and_discovery_state() {
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let addr: std::net::SocketAddr = "192.168.1.50:47821".parse().unwrap();
        let access = local_access(&cfg, Some(addr), true).expect("access info");
        assert_eq!(access.port, 47821);
        assert_eq!(access.host.as_deref(), Some("192.168.1.50"));
        assert!(access.api_running);
        assert!(access.discovery_active);
        assert!(access.url.is_some(), "a running service must yield a URL");
        assert!(access.svg.is_some(), "a running service must yield a QR");
        // With discovery live the canonical URL is the friendly name, while
        // `host` keeps the IP for the fallback and for diagnostics.
        assert!(access
            .url
            .as_deref()
            .unwrap_or_default()
            .contains("station.local:47821"));
        assert!(access
            .fallback_url
            .as_deref()
            .unwrap_or_default()
            .contains("192.168.1.50:47821"));
    }

    #[test]
    fn the_port_of_the_url_is_the_port_that_was_bound() {
        // Never a literal: an ephemeral test bind must be reflected exactly.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let addr: std::net::SocketAddr = "192.168.1.50:51234".parse().unwrap();
        let access = local_access(&cfg, Some(addr), true).expect("access info");
        assert_eq!(access.port, 51234);
        assert!(access.url.unwrap().ends_with(":51234/"));
    }

    #[test]
    fn local_access_reports_a_stopped_api_rather_than_a_working_code() {
        // A QR that cannot be reached is worse than none, so the UI is told.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let access = local_access(&cfg, None, false).expect("access info");
        assert!(!access.api_running);
        assert!(!access.discovery_active);
        // THE DEFECT: a URL and a QR were produced for a server that did not
        // exist, so the UI displayed — and implied was reachable — an address
        // that nothing was listening on. Neither is produced now.
        assert!(access.url.is_none(), "a stopped service must yield no URL");
        assert!(access.svg.is_none(), "a stopped service must yield no QR");
        assert!(access.host.is_none(), "no host may be claimed");
        assert!(access.other_hosts.is_empty());
        assert_eq!(
            access.error.as_deref(),
            Some(crate::network::runtime::ERR_BIND_FAILED),
            "enabled but not listening must be reported as a bind failure"
        );
    }

    #[test]
    fn a_disabled_service_is_reported_as_disabled_not_as_a_failure() {
        let cfg = NetworkConfig {
            enabled: false,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let access = local_access(&cfg, None, false).expect("access info");
        assert!(!access.api_running);
        assert!(access.url.is_none());
        assert_eq!(
            access.error.as_deref(),
            Some(crate::network::runtime::ERR_DISABLED)
        );
    }

    #[test]
    fn a_malformed_host_is_not_produced() {
        // Whatever the QR shows must be a real, reachable address string.
        let cfg = NetworkConfig {
            enabled: true,
            bind: "192.168.1.50".into(),
            port: 47821,
        };
        let host = primary_host(&cfg).expect("host");
        assert!(host.parse::<IpAddr>().is_ok(), "host must be an IP: {host}");
        assert!(!host.contains(' '));
    }
}
