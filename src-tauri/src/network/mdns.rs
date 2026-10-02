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
//! - **Exactly one address, and it is the bound one.** `station.local` resolves
//!   to precisely the address the HTTP listener has bound, and to nothing else.
//!   Automatic address discovery (`enable_addr_auto`) is deliberately NOT used,
//!   because it widens the record to every interface on the machine — including
//!   loopback and IPv6 link-local `fe80::/10` addresses that a browser cannot
//!   connect to, which made Safari retry `station.local` indefinitely instead
//!   of loading the page. See [`Advertisement::register`].
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

use mdns_sd::{HostnameResolutionEvent, IfKind, ScopedIp, ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

/// The DNS-SD service type. `_station._tcp` is a private, unregistered type
/// used precisely because Station is not a public protocol — no third party
/// can meaningfully claim it.
pub const SERVICE_TYPE: &str = "_station._tcp.local.";

/// How long Station waits to prove its OWN name resolves before deciding
/// whether a hostname may go on the QR code.
///
/// This is the whole cost of the fix and it is deliberately small and BOUNDED:
///
/// - It happens ONCE, when the LAN service is applied — never per connection,
///   so a client waiting on the LAN never pays it.
/// - It runs AFTER the HTTP listener has already been bound and spawned
///   (see [`crate::network::runtime`]), so it cannot delay the socket.
/// - The mDNS search itself is given a hard timeout, and the channel is read
///   with a deadline, so a responder that never answers costs this budget and
///   no more. Measured on the development machine: a correct advertisement
///   answers in ~1.0 s; an absent one returns `SearchTimeout` at the budget.
///
/// A phone that cannot resolve `station.local` does not fail fast — it stalls
/// for seconds (measured: 4.9 s via `curl`, 10.0 s via `dscacheutil`) and then
/// shows an error. Paying ~1 s ONCE at service start to know whether that stall
/// is what the QR would inflict on every scan is the trade this budget exists to
/// make.
pub const VERIFY_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

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
///
/// # WHY NOT A BRANDED SUFFIX SUCH AS `.lynk`
///
/// A shorter, branded suffix was evaluated and REJECTED on technical grounds,
/// not stylistic ones. A name outside `.local` cannot be resolved on a LAN with
/// no infrastructure:
///
/// - **mDNS will not carry it.** RFC 6762 §2 reserves `.local.` for multicast
///   DNS; a resolver never sends a multicast query for `station.lynk`, so the
///   responder is never asked. The implementation used here enforces the same
///   rule rather than merely assuming it — `mdns_sd` rejects any registered
///   hostname that does not end in `.local.`, so `station.lynk` cannot even be
///   advertised (asserted in this module's tests).
/// - **Unicast DNS cannot carry it either, offline.** There is no resolver on a
///   cafe LAN to ask. Making `station.lynk` work would require either a public
///   TLD with authoritative records (a cloud dependency and an internet
///   requirement, both forbidden by this project's offline-first contract) or
///   per-network router/DHCP configuration the app cannot install or verify.
///
/// Printing `http://station.lynk:47821/` on a QR code would therefore be a
/// promise no phone could keep: the name would silently fall through to the
/// router's DNS, fail, and cost the manager a multi-second stall on every scan.
/// `.local` is not a branding limitation — it is the only suffix in which the
/// hostname can actually resolve itself.
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
    // `addr_auto` is DELIBERATELY NOT enabled. See the note on
    // `Advertisement::register` — it is what made `station.local` unusable.
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
    ///
    /// # WHY `addr_auto` IS NOT USED
    ///
    /// `enable_addr_auto()` reads as a strict improvement — it re-advertises
    /// when a DHCP lease moves — but in `mdns-sd` it does something far more
    /// than that: at registration time the daemon inserts the address of EVERY
    /// UP interface, loopback included, into this hostname's A and AAAA
    /// records. On a real cafe PC that means `station.local` is published as
    /// the LAN IPv4 *plus* `127.0.0.1` *plus* a dozen `fe80::/10` IPv6
    /// link-local addresses belonging to `en0`, `en1`, `en2`, `bridge0`, `ap1`
    /// and every `utun`.
    ///
    /// `fe80::` addresses carry a zone index, are only meaningful on the local
    /// segment, and are not something a browser can connect to from a resolved
    /// name. Safari prefers AAAA, tries those first, and gets no answer — so
    /// `http://station.local:47821/` sat in `SYN_SENT` and spun instead of
    /// rendering. It is the same class of mistake
    /// [`crate::network::address`] refuses: publishing an address no client can
    /// actually use.
    ///
    /// So exactly ONE address is advertised: the one the HTTP listener has
    /// already bound. That makes the name and the socket agree by
    /// CONSTRUCTION rather than by timing, and it is the address the IP
    /// fallback prints, so all three surfaces cannot drift.
    ///
    /// The DHCP-lease case is still covered, by a better mechanism: a lease
    /// change makes the bound address stale, and [`crate::network::runtime`]
    /// tears the listener down and re-advertises whenever the service is
    /// applied. Correctness of what is on the wire beats a stale-proof that
    /// publishes unusable addresses in the meantime.
    ///
    /// # WHY THE RESPONDER IS PINNED TO ONE INTERFACE
    ///
    /// Left alone, `mdns-sd` joins multicast on EVERY address it finds. On a
    /// real cafe PC (verified on the development machine) that is `lo0` for both
    /// IPv4 and IPv6, `en6` and `ap1` for IPv6, and only then `en0` — the one
    /// interface the manager's phone is actually on. The record itself was
    /// already scoped correctly, but the responder was listening on adapters
    /// that have nothing to do with the cafe LAN: VPN tunnels, Thunderbolt
    /// bridges, virtual switches, loopback.
    ///
    /// That is noise on a healthy machine and a liability on an awkward one —
    /// an extra interface is one more chance to advertise somewhere the phone
    /// cannot see, and one more socket to fail on a locked-down host. The
    /// responder is therefore pinned to the interface carrying the address the
    /// listener bound, so "the name is advertised on the cafe LAN" is true by
    /// construction rather than by inspection of every adapter.
    ///
    /// `disable(All)` is sent before `enable(Addr)`: the daemon applies
    /// interface selections last-one-wins, in the order the commands were sent,
    /// and these are queued before `register` on the same channel. Pinning is
    /// best-effort — a daemon that refuses the option still serves every
    /// interface, which is the previous behaviour, not a new failure.
    pub fn register(ip: IpAddr, port: u16, app_version: &str) -> Result<Self, String> {
        let info = service_info(ip, port, app_version)?;
        let daemon =
            ServiceDaemon::new().map_err(|e| format!("cannot start mDNS responder: {e}"))?;
        // Best effort, and deliberately not fatal: a responder on all
        // interfaces is merely wasteful, whereas refusing to start would take
        // the hostname away entirely.
        let _ = daemon.disable_interface(IfKind::All);
        let _ = daemon.enable_interface(IfKind::Addr(ip));
        daemon
            .register(info)
            .map_err(|e| format!("cannot register Station over mDNS: {e}"))?;
        Ok(Self { daemon })
    }

    /// Prove the advertised name actually resolves back to `expected`.
    ///
    /// THE FIX. Registration returning `Ok` proves only that Station sent a
    /// packet; it proves nothing about whether a client on the cafe Wi-Fi can
    /// resolve the name. Trusting it anyway is what put an unresolvable
    /// `http://station.local:47821/` on the QR code, where every single scan
    /// then cost the manager a multi-second resolver stall before failing.
    ///
    /// So the name is not trusted until it has answered for itself. This asks
    /// the responder we just registered to resolve [`LAN_HOSTNAME`] over the
    /// very same multicast path a phone would use, and accepts the answer only
    /// if it names the address the HTTP listener is bound to. A mismatch means
    /// something else on the network owns the name — which is precisely the
    /// case where a phone must NOT be sent there.
    ///
    /// Bounded by [`VERIFY_BUDGET`] in both directions: the mDNS search is
    /// given that timeout, and the channel read is given a hard deadline
    /// beyond it, so a resolver that never answers cannot wedge the caller.
    /// Runs once, after the listener is already serving.
    pub fn verify(&self, expected: IpAddr, budget: std::time::Duration) -> Result<(), String> {
        let name = mdns_host_name();
        let events = self
            .daemon
            .resolve_hostname(&name, Some(budget.as_millis() as u64))
            .map_err(|e| format!("cannot query {name}: {e}"))?;

        // The deadline exceeds the search budget so the daemon's own
        // `SearchTimeout` is what ends the wait, not the clock racing it.
        let deadline = budget + std::time::Duration::from_millis(500);
        loop {
            let event = events
                .recv_timeout(deadline)
                .map_err(|e| format!("{name} did not resolve within {budget:?}: {e}"))?;
            // `SearchStarted` is progress, not an answer: keep waiting for the
            // address or for the timeout.
            if let Some(found) = resolved_addresses(&event) {
                if found.contains(&expected) {
                    return Ok(());
                }
                return Err(format!(
                    "{name} resolves to {found:?}, not to the address this Station is \
                     bound to ({expected}); another host on the network may own the name"
                ));
            }
        }
    }
}

/// The addresses a resolution event resolved to, if it resolved at all.
///
/// Split out from [`Advertisement::verify`] so the decision — "did the name
/// come back pointing at us?" — is a pure function that can be tested with no
/// network, no multicast and no daemon at all. `SearchStarted` (progress) and
/// `SearchStopped`/`SearchTimeout` (no answer) both correctly yield `None`;
/// only `AddressesFound` carries one.
fn resolved_addresses(event: &HostnameResolutionEvent) -> Option<Vec<IpAddr>> {
    match event {
        HostnameResolutionEvent::AddressesFound(_, addrs) => {
            Some(addrs.iter().map(ScopedIp::to_ip_addr).collect::<Vec<_>>())
        }
        _ => None,
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
    use mdns_sd::{InterfaceId, ScopedIp, ScopedIpV4};
    use std::collections::HashSet;
    use std::net::Ipv4Addr;

    /// A `ScopedIp` as the resolver reports it: an address plus the interface
    /// it was seen on.
    fn scoped(addr: Ipv4Addr) -> ScopedIp {
        ScopedIp::V4(ScopedIpV4::new(
            addr,
            InterfaceId {
                name: "en0".into(),
                index: 6,
            },
        ))
    }

    fn found(addrs: impl IntoIterator<Item = ScopedIp>) -> HashSet<ScopedIp> {
        addrs.into_iter().collect()
    }

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
    fn it_advertises_exactly_the_bound_address_and_nothing_else() {
        /*
         * THE DEFECT. `enable_addr_auto()` made the daemon add the address of
         * every up interface — loopback included — plus every `fe80::/10`
         * IPv6 link-local address on the machine. `station.local` therefore
         * resolved to a bundle of addresses a browser cannot connect to, and
         * Safari retried them forever instead of rendering the page.
         *
         * A client must now get ONE address, and it must be the one the HTTP
         * listener is bound to. Auto-discovery stays off.
         */
        assert!(
            !info().is_addr_auto(),
            "automatic address discovery must stay OFF or station.local \
             publishes unreachable fe80::/loopback addresses again"
        );

        // Exactly one address, and it is the bound one.
        assert_eq!(
            info()
                .get_addresses_v4()
                .into_iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![Ipv4Addr::new(192, 168, 1, 50)],
            "station.local must resolve to the bound address alone"
        );

        // Belt and braces: the set is never widened, and never carries an IPv6
        // record a browser could try (and fail on) before the IPv4 one.
        for info in [
            service_info(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 47821, "0.1.0").unwrap(),
            service_info(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)), 47821, "0.1.0").unwrap(),
        ] {
            assert_eq!(
                info.get_addresses_v4().len(),
                1,
                "the advertised address set must never be widened"
            );
            assert_eq!(
                info.get_addresses().len(),
                1,
                "no IPv6 record may be published alongside the bound IPv4"
            );
            assert!(!info.is_addr_auto());
        }
    }

    #[test]
    fn the_advertised_address_is_the_one_the_listener_bound() {
        // The name and the socket cannot point at different interfaces: both
        // come from the same `SocketAddr` that `runtime::apply` bound.
        let bound: IpAddr = "192.168.1.61".parse().unwrap();
        let info = service_info(bound, 47821, "0.1.0").unwrap();
        assert_eq!(
            info.get_addresses_v4()
                .into_iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![Ipv4Addr::new(192, 168, 1, 61)]
        );
        // And the fallback URL the QR prints for the very same listener is that
        // address on that very port, so hostname and IP reach one server.
        assert_eq!(
            crate::network::qr::access_url(
                &crate::network::address::url_host(&bound),
                info.get_port()
            ),
            "http://192.168.1.61:47821/"
        );
        assert_eq!(
            crate::network::qr::friendly_url(info.get_port()),
            "http://station.local:47821/"
        );
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
    fn a_name_resolving_to_another_host_is_not_accepted_as_ours() {
        // Two Stations on one cafe Wi-Fi both claim `station.local`, and a
        // phone may be handed either address. Verification must reject an
        // answer that is not the address THIS listener bound — otherwise the
        // QR would cheerfully send a manager to a different till.
        let event = HostnameResolutionEvent::AddressesFound(
            "station.local.".into(),
            found([scoped(Ipv4Addr::new(10, 0, 0, 9))]),
        );
        let resolved = resolved_addresses(&event).expect("an answer arrived");
        let ours = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 88));
        assert!(
            !resolved.contains(&ours),
            "another host's address must never pass as ours"
        );
        // A mixed answer — ours among others — is still accepted, because a
        // phone may legitimately be handed either record.
        let mixed = HostnameResolutionEvent::AddressesFound(
            "station.local.".into(),
            found([
                scoped(Ipv4Addr::new(10, 0, 0, 9)),
                scoped(Ipv4Addr::new(192, 168, 1, 88)),
            ]),
        );
        assert!(resolved_addresses(&mixed)
            .expect("an answer arrived")
            .contains(&ours));
    }

    #[test]
    fn the_responder_is_pinned_to_the_bound_interface() {
        /*
         * THE INTERFACE HALF OF THE FIX. Left to itself `mdns-sd` joins
         * multicast on every adapter it finds — verified on the development
         * machine as `lo0` (v4 and v6), `en6`, `ap1`, and only then `en0`, the
         * interface the cafe LAN is actually on.
         *
         * `register` now narrows the daemon to the bound address, so the record
         * is published on the interface the socket was bound to and nowhere
         * else. Pinning is done with the address the listener gave us, so the
         * two agree by construction rather than by inspecting every adapter.
         */
        let source = include_str!("mdns.rs");
        let production = &source[..source
            .find("#[cfg(test)]")
            .expect("mdns.rs keeps its tests in one trailing module")];
        assert!(
            production.contains("disable_interface(IfKind::All)"),
            "the responder must stop listening on every interface"
        );
        assert!(
            production.contains("enable_interface(IfKind::Addr(ip))"),
            "and must be narrowed to the address the listener bound"
        );
        // Ordering matters: selections are applied last-one-wins in the order
        // they were sent, and these are queued before the registration.
        let disable = production
            .find("disable_interface(IfKind::All)")
            .expect("narrowing");
        let enable = production
            .find("enable_interface(IfKind::Addr(ip))")
            .expect("narrowing");
        let register = production.find(".register(info)").expect("registration");
        assert!(
            disable < enable && enable < register,
            "pin the interface BEFORE the record is registered"
        );
    }

    #[test]
    fn a_branded_suffix_outside_local_cannot_be_advertised() {
        /*
         * WHY THE HOSTNAME IS `station.local` AND NOT, SAY, `station.lynk`.
         *
         * This is not a naming preference — it is a hard limit of the
         * mechanism, asserted here rather than argued in a comment. RFC 6762
         * reserves `.local.` for multicast DNS, and the responder refuses to
         * register or resolve any other name, so a branded suffix simply cannot
         * be published. The only ways to make one resolve would be a public TLD
         * with authoritative DNS, or per-router configuration: a cloud
         * dependency and an internet requirement, both of which this
         * offline-first application exists to avoid.
         */
        let branded = ServiceDaemon::new().expect("daemon");
        for name in ["station.lynk.", "station-cafe.example.", "station."] {
            assert!(
                branded.resolve_hostname(name, Some(1)).is_err(),
                "{name} must not be resolvable by the LAN mechanism"
            );
        }
        // The one that IS legal, and the one Station uses.
        assert!(branded.resolve_hostname(&mdns_host_name(), Some(1)).is_ok());
        drop(branded);
    }

    #[test]
    fn the_verify_budget_is_small_and_bounded() {
        /*
         * The fix costs a bounded wait ONCE, at service start. If this budget
         * were allowed to grow — "a few seconds to be safe" — a pathological
         * machine would start paying it on every apply, and the bounded
         * fallback that keeps the QR on a working IP would stop being bounded.
         * 1.5 s comfortably covers the ~1.0 s a correct advertisement takes.
         */
        assert_eq!(VERIFY_BUDGET, std::time::Duration::from_millis(1500));
        assert!(VERIFY_BUDGET < std::time::Duration::from_secs(2));
        // And never zero, which would reject every name by default.
        assert!(VERIFY_BUDGET > std::time::Duration::from_millis(0));
    }

    #[test]
    fn only_an_addresses_found_event_counts_as_an_answer() {
        // The verification decision, with no network involved. `SearchStarted`
        // is progress; `SearchTimeout`/`SearchStopped` are absence. Treating
        // either as success would put an unresolvable name back on the QR.
        assert_eq!(
            resolved_addresses(&HostnameResolutionEvent::AddressesFound(
                "station.local.".into(),
                found([scoped(Ipv4Addr::new(192, 168, 1, 88))])
            )),
            Some(vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 88))])
        );
        assert!(resolved_addresses(&HostnameResolutionEvent::SearchStarted(
            "station.local.".into()
        ))
        .is_none());
        assert!(resolved_addresses(&HostnameResolutionEvent::SearchTimeout(
            "station.local.".into()
        ))
        .is_none());
        assert!(resolved_addresses(&HostnameResolutionEvent::SearchStopped(
            "station.local.".into()
        ))
        .is_none());
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

