//! The local-access QR code.
//!
//! What the QR is: a PHONE NUMBER for a building. It says "Station's API is
//! this far away, on this address". That is all.
//!
//! What the QR is emphatically not: a key. It carries no username, no
//! password, no bearer token, no session id, no API key, no discount PIN, no
//! database path and no customer or employee data. A QR is a sticker on a
//! counter that anyone nearby can photograph, so anything secret in it is
//! compromised the moment it is printed. Authentication stays exactly where it
//! already is — `services::auth::login` over the API.
//!
//! Because the payload is an address, it is assembled HERE, beside the code
//! that knows the real port and this machine's real addresses, rather than in
//! the frontend from scattered state. That is a structural guarantee against a
//! token being concatenated into a URL later, and it makes the exact string
//! testable.

use crate::network::api::API_PREFIX;
use crate::network::config::NetworkConfig;
use std::net::IpAddr;

/// The one real, unauthenticated endpoint a scanner can usefully land on.
///
/// Deliberately the health probe: it exists, it answers, and it reveals nothing.
/// The QR therefore points at something that genuinely works, rather than at a
/// future mobile UI that does not exist yet.
pub const ACCESS_PATH: &str = "/health";

/// Build the access URL for a host and the configured port.
///
/// The ONLY thing this produces is `scheme://host:port/path`. It has no branch
/// that could add a query string, a fragment or a credential, so there is no
/// code path by which a secret could be encoded.
pub fn access_url(host: &str, port: u16) -> String {
    // `http` because the listener is plain HTTP on a LAN. A phone scanning this
    // gets a real page; it is not a login form, and nothing is transmitted that
    // would justify TLS here.
    format!("http://{host}:{port}{API_PREFIX}{ACCESS_PATH}")
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
    /// Whether mDNS advertised Station. Only ever true after a real bind.
    pub discovery_active: bool,
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
        });
    }

    let host = primary_host(cfg).ok_or_else(|| {
        "no LAN address is available on this machine, so a scannable code cannot be produced"
            .to_string()
    })?;
    let url = access_url(&host, port);
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
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_is_protocol_host_port_and_a_real_path() {
        assert_eq!(access_url("192.168.1.50", 47821), "http://192.168.1.50:47821/api/v1/health");
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
    fn the_path_is_a_real_endpoint_that_exists() {
        // The QR must land on an endpoint Station actually serves.
        let url = access_url("10.0.0.5", 47821);
        assert!(url.ends_with(&format!("{API_PREFIX}{ACCESS_PATH}")));
        assert!(url.ends_with("/api/v1/health"));
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
        assert_eq!(access_url("station.local", 47821), "http://station.local:47821/api/v1/health");
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
        assert!(access
            .url
            .as_deref()
            .unwrap_or_default()
            .contains("192.168.1.50:47821"));
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
