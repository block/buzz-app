//! The admin network policy: HTTPS public origins only, one DNS answer per
//! request that is vetted and then pinned, no proxies, no redirects.

use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use url::{Host, Url};

pub(super) type Lookup<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;

pub(super) trait Resolve: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a>;
}

struct SystemDns;

impl Resolve for SystemDns {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
}

/// How admin requests reach the network. Production uses system DNS and the
/// public-address rule; tests substitute both to drive a loopback fixture.
#[derive(Clone)]
pub(super) struct Net {
    resolver: Arc<dyn Resolve>,
    allowed: fn(IpAddr) -> bool,
    #[cfg(test)]
    pub(super) root: Option<reqwest::Certificate>,
}

impl Net {
    pub(super) fn system() -> Self {
        Self {
            resolver: Arc::new(SystemDns),
            allowed: public,
            #[cfg(test)]
            root: None,
        }
    }

    #[cfg(test)]
    pub(super) fn custom(resolver: Arc<dyn Resolve>, allowed: fn(IpAddr) -> bool) -> Self {
        Self {
            resolver,
            allowed,
            root: None,
        }
    }

    /// Resolves once, refuses unless every answer is allowed, and returns a
    /// client that can connect only to those answers. The hostname stays in
    /// the URL, so TLS and NIP-98 still name it.
    pub(super) async fn client(&self, origin: &Url) -> Result<reqwest::Client, String> {
        let port = origin
            .port_or_known_default()
            .ok_or("Invalid admin origin")?;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30));
        #[cfg(test)]
        if let Some(root) = &self.root {
            builder = builder.tls_certs_merge([root.clone()]);
        }
        match origin.host().ok_or("Invalid admin origin")? {
            Host::Ipv4(ip) if (self.allowed)(ip.into()) => {}
            Host::Ipv6(ip) if (self.allowed)(ip.into()) => {}
            Host::Ipv4(_) | Host::Ipv6(_) => return Err(REFUSED.into()),
            Host::Domain(name) => {
                let answers = self
                    .resolver
                    .lookup(name, port)
                    .await
                    .map_err(|_| "The admin host could not be resolved")?;
                if answers.is_empty() {
                    return Err("The admin host could not be resolved".into());
                }
                if !answers.iter().all(|addr| (self.allowed)(addr.ip())) {
                    return Err(REFUSED.into());
                }
                let pinned: Vec<SocketAddr> = answers
                    .iter()
                    .map(|addr| SocketAddr::new(addr.ip(), port))
                    .collect();
                builder = builder.resolve_to_addrs(name, &pinned);
            }
        }
        builder
            .build()
            .map_err(|_| "Admin network client is unavailable".into())
    }
}

const REFUSED: &str = "The admin host resolves to a private or local address";

/// Syntactic admin-origin rule, checked before any lookup: an HTTPS origin
/// (no credentials, path, query or fragment), not a local name, and not a
/// non-public literal address.
pub(super) fn admin_origin(value: &str) -> Result<Url, String> {
    let url = crate::relay::origin(value)?;
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.');
            let local = ["localhost", "local", "internal", "home.arpa", "lan"]
                .iter()
                .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")));
            if local || !name.contains('.') {
                return Err("The admin host must be a public name".into());
            }
        }
        Some(Host::Ipv4(ip)) if public(ip.into()) => {}
        Some(Host::Ipv6(ip)) if public(ip.into()) => {}
        _ => return Err(REFUSED.into()),
    }
    Ok(url)
}

/// Globally routable unicast only.
pub(super) fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..20).contains(&b))
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // Global unicast is 2000::/3. Inside it, refuse ranges that embed or
    // tunnel to arbitrary IPv4 (6to4, Teredo), documentation, and ORCHID.
    (s[0] & 0xe000) == 0x2000
        && s[0] != 0x2002
        && !(s[0] == 0x2001 && (s[1] == 0 || s[1] == 0x0db8 || (s[1] & 0xfff0) == 0x0010))
}
