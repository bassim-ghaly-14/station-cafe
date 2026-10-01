//! mDNS/DNS-SD advertisement — a CONVENIENCE, never the source of truth.
//!
//! What this module is allowed to do is publish that Station exists, under the
//! name `station.local`, and on which port. What it must never do is become a
//! dependency: the HTTP API in [`super::server`] is the real target, and the
//! runtime IP is always authoritative.
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
//!
//! What this module advertises is a NAME, not a socket. `station.local` is
//! published as an mDNS hostname pointing at this machine's LAN address, which
//! is what makes `http://station.local:47821/` resolve on a phone. The HTTP
//! listener keeps binding to an IP ([`super::runtime`]); the two are separate
//! concerns and must stay separate — an mDNS name is not a `SocketAddr` and is
//! never passed to `bind`.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

/// The DNS-SD service type. `_station._tcp` is a private, unregistered type
/// used precisely because Station is not a public protocol — no third party
/// can meaningfully claim it.
pub const SERVICE_TYPE: &str = "_station._tcp.local.";

/// The canonical, friendly Station LAN hostname — ONE source for the whole
/// application.
///
/// This constant is what mDNS advertises AND what the QR code encodes AND what
/// Dev Settings displays, so those three surfaces cannot disagree. It is
/// deliberately not configurable: a manager's phone has to know one name to
/// type, and a second setting for it would only create a way for the QR to
/// point somewhere the advertisement does not.
///
/// `.local` is reserved by RFC 6762 for link-local multicast, so this name can
/// only ever be resolved ON the cafe's own network. It is not routable, is not
/// published to any public DNS, and cannot expose Station beyond the LAN. The
/// IP fallback (see [`super::qr`]) remains the guarantee for a client whose
/// device does not answer mDNS queries at all.
pub const LAN_HOSTNAME: &str = "station.local";

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
///
/// `ip` is this machine's real LAN address, never a literal: the listener has
/// already bound it in [`super::runtime`] by the time this is called, so the
/// name and the socket cannot point at different interfaces.
pub fn service_info(ip: IpAddr, port: u16, app_version: &str) -> Result<ServiceInfo, String> {
    // Typed as a slice, not an array: the crate's `IntoTxtProperties` is
    // implemented for `&[T]`, and an `&[T; 1]` does not coerce during trait
    // resolution.
    let properties: &[(&str, &str)] = &[("version", app_version)];
    ServiceInfo::new(
        SERVICE_TYPE,
        INSTANCE_NAME,
        &mdns_host_name(),
        ip,
        port,
        properties,
    )
    // Re-advertise automatically when the host's addresses change, so a
    // DHCP lease change cannot leave a stale address published.
    .map(ServiceInfo::enable_addr_auto)
    .map_err(|e| format!("cannot build mDNS service info: {e}"))
}

/// The FQDN form of [`LAN_HOSTNAME`] as the wire format requires it.
///
/// DNS-SD hostnames are absolute: they carry the trailing dot (`station.local.`)
/// and `ServiceDaemon::register` REJECTS anything else, so the dotted form is
/// what is published while [`LAN_HOSTNAME`] — undotted, the form a person types
/// in a browser — stays the single constant the rest of the application uses.
///
/// This is the resolution mechanism: registering this hostname makes a client
/// on the LAN that queries `station.local` receive this machine's address back
/// from the responder. No external DNS, no router configuration, no cloud.
pub fn mdns_host_name() -> String {
    format!("{LAN_HOSTNAME}.")
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
    fn it_advertises_the_canonical_station_hostname() {
        // THE CONTRACT: this is the friendly name the QR encodes and Dev
        // Settings shows, so it must be the name actually on the wire.
        assert_eq!(info().get_hostname(), "station.local.");
    }

    #[test]
    fn the_advertised_hostname_is_the_canonical_constant() {
        // One source. If this fails, the QR would point at a name nothing
        // advertises — the exact failure that made this change necessary.
        assert_eq!(mdns_host_name(), format!("{LAN_HOSTNAME}."));
    }

    #[test]
    fn the_hostname_is_absolute_as_dns_sd_requires() {
        // `ServiceDaemon::register` rejects anything that does not end in
        // `.local.`, so an undotted hostname would fail registration at runtime
        // instead of failing here.
        assert!(mdns_host_name().ends_with(".local."));
        assert!(!mdns_host_name().ends_with(".local.."));
        // And the typed form carries no trailing dot.
        assert!(!LAN_HOSTNAME.ends_with('.'));
    }

    #[test]
    fn the_typed_hostname_is_station_local() {
        // Pinned so the QR, Dev Settings and the advertisement cannot drift.
        assert_eq!(LAN_HOSTNAME, "station.local");
        // RFC 6762: `.local` is reserved for link-local multicast, so this can
        // only ever resolve on the cafe's own network. Asserted so it cannot be
        // quietly replaced with a public domain.
        assert!(LAN_HOSTNAME.ends_with(".local"));
    }

    #[test]
    fn the_hostname_is_not_derived_from_the_os() {
        // A cafe PC named "DESKTOP-7K2" must still answer as station.local;
        // otherwise the QR would encode a name the manager has to guess.
        std::env::set_var("HOSTNAME", "DESKTOP-7K2");
        assert_eq!(info().get_hostname(), "station.local.");
        std::env::remove_var("HOSTNAME");
        assert_eq!(info().get_hostname(), "station.local.");
    }
}

