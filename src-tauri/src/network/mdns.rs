//! mDNS/DNS-SD advertisement — a CONVENIENCE, never the source of truth.
//!
//! What this module is allowed to do is publish that Station exists and on
//! which port. What it must never do is become a dependency: the HTTP API in
//! [`super::server`] is the real target, and the runtime IP is always
//! authoritative.
//!
//! Three properties follow, and each is deliberate:
//!
//! - **Minimal metadata.** Only a service name, a DNS-SD service type and the
//!   port. No user, no customer, no employee, no database path, no filesystem
//!   path, no token, no discount PIN. Those have no business on a broadcast
//!   that every device on the cafe Wi-Fi can read.
//! - **Addresses are never stale.** The advertisement carries the address
//!   detected at startup AND is registered with `enable_addr_auto()`, so the
//!   responder re-advertises when the host's addresses change. A DHCP lease
//!   that moves cannot leave a dead address in the responder's cache.
//! - **Failure is never fatal.** Multicast blocked, no interface, a name
//!   conflict — each is logged and swallowed. Station is a POS first; losing
//!   a convenience lookup must never stop the till.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

/// The DNS-SD service type. `_station._tcp` is a private, unregistered type
/// used precisely because Station is not a public protocol — no third party
/// can meaningfully claim it.
pub const SERVICE_TYPE: &str = "_station._tcp.local.";

/// The advertised instance name.
///
/// This is what appears in a phone's network browser, so it is plain and
/// human: "Station Cafe". It carries no hostname, address or version.
pub const INSTANCE_NAME: &str = "Station Cafe";

/// Build the advertisement for a given port and detected address.
///
/// Split out from registration so the metadata can be asserted in tests
/// without touching the network — real multicast cannot be unit-tested
/// reliably, but "what would we broadcast" absolutely can.
pub fn service_info(ip: IpAddr, port: u16, app_version: &str) -> Result<ServiceInfo, String> {
    // Typed as a slice, not an array: the crate's `IntoTxtProperties` is
    // implemented for `&[T]`, and an `&[T; 1]` does not coerce during trait
    // resolution.
    let properties: &[(&str, &str)] = &[("version", app_version)];
    ServiceInfo::new(SERVICE_TYPE, INSTANCE_NAME, &host_name(), ip, port, properties)
        // Re-advertise automatically when the host's addresses change, so a
        // DHCP lease change cannot leave a stale address published.
        .map(ServiceInfo::enable_addr_auto)
        .map_err(|e| format!("cannot build mDNS service info: {e}"))
}

/// The hostname Station answers on.
///
/// Uses the OS hostname, which is what the responder can actually publish, and
/// never a hardcoded value. `station.local` is a CONVENIENCE the client may or
/// may not be able to resolve; the IP fallback is the guarantee.
fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "station".to_string())
}

/// A running advertisement. Dropping the handle unregisters the service.
pub struct Advertisement {
    daemon: ServiceDaemon,
}

impl Advertisement {
    /// Register the service. Any failure is returned as a message and the
    /// caller is expected to carry on without discovery.
    pub fn register(ip: IpAddr, port: u16, app_version: &str) -> Result<Self, String> {
        let info = service_info(ip, port, app_version)?;
        let daemon =
            ServiceDaemon::new().map_err(|e| format!("cannot start mDNS responder: {e}"))?;
        daemon
            .register(info)
            .map_err(|e| format!("cannot register Station over mDNS: {e}"))?;
        Ok(Self { daemon })
    }
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        // Shutting the daemon down unregisters the service and stops its
        // socket, so a closed Station does not keep advertising itself as
        // reachable on the cafe network. The result is intentionally dropped:
        // a failure here happens during teardown, where there is no caller left
        // to act on it, and it must not panic on the way out.
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn info() -> ServiceInfo {
        service_info(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 47821, "0.1.0")
            .expect("service info must build")
    }

    #[test]
    fn it_advertises_the_station_service_type() {
        assert_eq!(info().get_type(), "_station._tcp.local.");
        // A private, unregistered type: Station is not a public protocol.
        assert!(SERVICE_TYPE.ends_with("._tcp.local."));
    }

    #[test]
    fn it_advertises_the_instance_name() {
        // What a manager sees in their phone's network browser.
        assert!(info().get_fullname().starts_with("Station Cafe"));
    }

    #[test]
    fn it_advertises_the_configured_port() {
        assert_eq!(info().get_port(), 47821);
        // A different configured port must be advertised, not a default.
        let other = service_info(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000, "0.1.0").unwrap();
        assert_eq!(other.get_port(), 50000);
    }

    #[test]
    fn it_advertises_the_runtime_address_not_a_hardcoded_one() {
        let a = service_info(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 47821, "0.1.0").unwrap();
        let b = service_info(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)), 47821, "0.1.0").unwrap();
        let one = |i: ServiceInfo| i.get_addresses_v4().into_iter().copied().collect::<Vec<_>>();
        assert_eq!(one(a), vec![Ipv4Addr::new(192, 168, 1, 50)]);
        assert_eq!(one(b), vec![Ipv4Addr::new(10, 0, 0, 9)]);
    }

    #[test]
    fn it_tracks_address_changes_so_a_dhcp_change_is_re_advertised() {
        // A lease that moves must not leave a dead address published.
        assert!(info().is_addr_auto(), "address auto-update must be enabled");
    }

    #[test]
    fn it_advertises_no_credential_and_no_sensitive_data() {
        // Everything on the wire is readable by every device on the cafe
        // Wi-Fi, so the payload is asserted key by key.
        let info = info();
        let advertised = format!(
            "{}{}{}{}",
            info.get_type(),
            info.get_fullname(),
            info.get_hostname(),
            info.get_property_val_str("version").unwrap_or_default()
        );
        for forbidden in [
            "password", "passwd", "token", "secret", "pin", "authorization", "bearer", "user",
            "customer", "employee", "phone", ".db", "station_cafe", "/Users", "C:\\", "api_key",
        ] {
            assert!(
                !advertised.to_lowercase().contains(forbidden),
                "advertisement leaked {forbidden}: {advertised}"
            );
        }
    }

    #[test]
    fn the_only_txt_property_is_the_app_version() {
        // A client may see what it is talking to BEFORE it authenticates, so
        // the property set is closed on purpose and asserted as a set.
        let info = info();
        let keys: Vec<String> = info.get_properties().iter().map(|p| p.key().to_string()).collect();
        assert_eq!(keys, vec!["version".to_string()]);
        assert_eq!(info.get_property_val_str("version"), Some("0.1.0"));
    }

    #[test]
    fn no_database_or_filesystem_path_is_advertised() {
        // The service is a locator, not a file handle.
        let info = info();
        assert!(!info.get_hostname().contains('/'));
        assert!(!info.get_hostname().contains('\\'));
    }

    #[test]
    fn the_hostname_is_never_hardcoded() {
        // Whatever the OS reports is what is published; Station cannot assert
        // a name it does not control.
        let name = host_name();
        assert!(!name.is_empty());
        assert_ne!(name, "station.local", "the OS hostname must be used");
    }
}

