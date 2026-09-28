//! Choosing WHICH address Station serves on.
//!
//! A real machine is not a clean network. The cafe PC running this may also
//! have a VPN (`utun0`…), a hotspot (`llw0`), AirDrop (`awdl0`), a virtual
//! bridge (`bridge0`, `ap1`) and a dozen `fe80::` link-local IPv6 addresses,
//! while the actual cafe LAN is one ordinary `en0`.
//!
//! `local_ip_address::local_ip()` answers "some local address" and makes no
//! promise about WHICH. Binding to, or printing in a QR, an address chosen that
//! way is how a manager ends up with a code that scans perfectly and reaches
//! nothing. So the choice is made here, explicitly, and the SAME function
//! feeds both the bind address and the QR — they can never disagree about
//! which interface Station is on.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Interface-name prefixes that are tunnels, sharing or virtualisation rather
/// than "the network the cafe is on".
///
/// Matched as a prefix so `utun0`..`utun4` are all covered. This is a
/// preference, not a hard filter: a name that is not on this list is still
/// allowed if it is the only route to the network.
const VIRTUAL_PREFIXES: [&str; 12] = [
    "lo", "utun", "awdl", "llw", "bridge", "ap", "gif", "stf", "vbox", "vmnet", "tun", "tap",
];

fn is_virtual_interface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// How suitable an address is for serving Station. Higher is better.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Suitability {
    /// Unusable: loopback, unspecified, multicast, link-local, documentation.
    Unusable,
    /// A routable IPv6 global address. Usable, but a phone on an IPv4-only LAN
    /// will not reach it, so it must never outrank a private IPv4.
    GlobalIpv6,
    /// A public IPv4 address. Reachable, but not what a cafe normally has.
    PublicIpv4,
    /// A private (RFC1918) IPv4 address — the normal, expected case.
    PrivateIpv4,
}

/// Classify an address. This is the single rule both binding and the QR obey.
pub fn classify(ip: &IpAddr) -> Suitability {
    match ip {
        // Never serve, never print: these cannot be reached from another
        // device, and 127.0.0.1 in a QR would point the phone at itself.
        IpAddr::V4(v4) if v4.is_loopback() || v4.is_unspecified() || v4.is_multicast() => {
            Suitability::Unusable
        }
        // 169.254/16 — link-local, only meaningful on the same L2 segment and
        // not a normal LAN address.
        IpAddr::V4(v4) if v4.is_link_local() => Suitability::Unusable,
        // 198.18/15 benchmarking and the RFC5737 documentation ranges are not
        // a cafe network.
        IpAddr::V4(v4) if matches!(v4.octets(), [198, 18, _, _]) => Suitability::Unusable,
        IpAddr::V4(v4) if v4.is_documentation() => Suitability::Unusable,
        IpAddr::V6(v6) if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() => {
            Suitability::Unusable
        }
        // fe80::/10 link-local carries a zone index, is only valid on-link, and
        // is not something a phone can be handed. Explicitly excluded.
        IpAddr::V6(v6) if v6.is_unicast_link_local() => Suitability::Unusable,
        IpAddr::V4(v4) if is_private_v4(v4) => Suitability::PrivateIpv4,
        IpAddr::V4(_) => Suitability::PublicIpv4,
        IpAddr::V6(v6) if is_unique_local_v6(v6) => Suitability::GlobalIpv6,
        // Anything else IPv6 is global unicast.
        IpAddr::V6(_) => Suitability::GlobalIpv6,
    }
}

/// RFC1918, determined arithmetically rather than by hardcoded network strings.
fn is_private_v4(v4: &Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

fn is_unique_local_v6(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// Is this address safe to use as a QR host AND as a bind target?
pub fn is_usable(ip: &IpAddr) -> bool {
    classify(ip) != Suitability::Unusable
}

/// Pick the address Station should serve on.
///
/// Preference order, highest first:
///  1. a private IPv4 on a real interface — the normal cafe LAN;
///  2. any other usable IPv4 on a real interface;
///  3. a usable IPv6;
///  4. the same, but from a virtual interface — only if it is all there is.
///
/// Returns `None` when nothing suitable exists, so the caller can fail safely
/// and say so, rather than binding somewhere useless.
pub fn select_lan_address() -> Option<IpAddr> {
    let interfaces = local_ip_address::list_afinet_netifas().ok()?;

    let mut best_real: Option<(Suitability, IpAddr)> = None;
    let mut best_virtual: Option<(Suitability, IpAddr)> = None;

    for (name, ip) in interfaces {
        let rank = classify(&ip);
        if rank == Suitability::Unusable {
            continue;
        }
        let slot = if is_virtual_interface(&name) {
            &mut best_virtual
        } else {
            &mut best_real
        };
        if slot.as_ref().is_none_or(|(current, _)| rank > *current) {
            *slot = Some((rank, ip));
        }
    }

    best_real
        .or(best_virtual)
        .map(|(_, ip)| ip)
        .or_else(|| local_ip_address::local_ip().ok().filter(is_usable))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn v4(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn v6(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn loopback_is_rejected_in_both_families() {
        // 127.0.0.1 in a QR would point the phone at itself.
        assert!(!is_usable(&v4("127.0.0.1")));
        assert!(!is_usable(&v4("127.1.2.3")));
        assert!(!is_usable(&v6("::1")));
    }

    #[test]
    fn unspecified_and_multicast_are_rejected() {
        for bad in ["0.0.0.0", "224.0.0.1", "239.255.255.250", "255.255.255.255", "ff02::1"] {
            assert!(!is_usable(&v4(bad)), "IPv4 {bad} must be rejected");
        }
        assert!(!is_usable(&v6("::")));
    }

    #[test]
    fn link_local_is_rejected() {
        // 169.254/16 and fe80::/10 are on-link only, not a cafe LAN address.
        assert!(!is_usable(&v4("169.254.10.1")));
        for bad in ["fe80::1", "fe80::aede:48ff:fe00:1122", "febf::1"] {
            assert!(!is_usable(&v6(bad)), "IPv6 {bad} must be rejected");
        }
    }

    #[test]
    fn private_lan_ipv4_is_accepted_and_outranks_everything_else() {
        for good in ["192.168.1.61", "10.0.0.5", "172.16.0.1", "172.31.255.254"] {
            let ip = v4(good);
            assert!(is_usable(&ip), "{good} must be accepted");
            assert_eq!(classify(&ip), Suitability::PrivateIpv4);
        }
        // The boundaries matter: 172.15/172.32 are NOT private.
        assert!(!is_private_v4(&v4("172.15.0.1").to_string().parse().unwrap()));
        assert!(!is_private_v4(&v4("172.32.0.1").to_string().parse().unwrap()));
    }

    #[test]
    fn a_private_ipv4_beats_public_ipv4_and_any_ipv6() {
        // This ordering is the whole point: a cafephone is on IPv4, so a
        // global IPv6 or a public IPv4 must never win over the LAN address.
        assert!(Suitability::PrivateIpv4 > Suitability::PublicIpv4);
        assert!(Suitability::PublicIpv4 > Suitability::GlobalIpv6);
        assert!(Suitability::GlobalIpv6 > Suitability::Unusable);
    }

    #[test]
    fn documentation_and_benchmarking_ranges_are_rejected() {
        for bad in ["192.0.2.10", "198.51.100.7", "203.0.113.9", "198.18.0.1"] {
            assert!(!is_usable(&v4(bad)), "{bad} must be rejected");
        }
    }

    #[test]
    fn virtual_and_tunnel_interfaces_are_identified() {
        // The real cafe PC had utun0-4, awdl0, llw0, ap1 and bridge0.
        for name in ["utun0", "utun4", "awdl0", "llw0", "bridge0", "ap1", "lo0", "gif0"] {
            assert!(is_virtual_interface(name), "{name} is virtual");
        }
        for name in ["en0", "en1", "eth0", "wlan0", "Wi-Fi"] {
            assert!(!is_virtual_interface(name), "{name} is a real interface");
        }
    }

    #[test]
    fn ipv6_hosts_are_bracketed_in_a_url() {
        // An unbracketed IPv6 literal produces a malformed URL that points
        // nowhere — the same failure as a wrong address, one step further.
        assert_eq!(url_host(&v4("192.168.1.61")), "192.168.1.61");
        assert_eq!(url_host(&v6("2001:db8::1")), "[2001:db8::1]");
    }

    #[test]
    fn the_selected_address_is_usable_when_one_exists() {
        // Whatever this machine has, the chosen address must be one we would
        // actually be willing to serve on and publish.
        if let Some(ip) = select_lan_address() {
            assert!(is_usable(&ip), "selected an unusable address: {ip}");
            assert!(!ip.is_loopback(), "selected loopback: {ip}");
        }
    }
}

/// Format a host for use in a URL.
///
/// An IPv6 literal MUST be bracketed or the URL is malformed and points
/// nowhere — the same class of bug as a wrong address, one step further away.
pub fn url_host(ip: &IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}
