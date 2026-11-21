//! The admin network policy over the shared public HTTPS transport: HTTPS
//! public origins only.

pub(super) use crate::public_https::Net;
#[cfg(test)]
pub(super) use crate::public_https::{public, Lookup, Resolve};
use crate::public_https::{public_host, Refusal};
use url::Url;

const REFUSED: &str = "The admin host resolves to a private or local address";

impl Net {
    /// A client that can connect only to the origin's vetted, pinned answers.
    pub(super) async fn client(&self, origin: &Url) -> Result<reqwest::Client, String> {
        self.builder(origin)
            .await
            .map_err(|refusal| match refusal {
                Refusal::Invalid => "Invalid admin origin",
                Refusal::Unresolved => "The admin host could not be resolved",
                Refusal::Private => REFUSED,
            })?
            .build()
            .map_err(|_| "Admin network client is unavailable".into())
    }
}

/// Syntactic admin-origin rule, checked before any lookup: an HTTPS origin
/// (no credentials, path, query or fragment), not a local name, and not a
/// non-public literal address.
pub(super) fn admin_origin(value: &str) -> Result<Url, String> {
    let url = crate::relay::origin(value)?;
    public_host(&url).map_err(|refusal| match refusal {
        Refusal::Private => REFUSED,
        _ => "The admin host must be a public name",
    })?;
    Ok(url)
}
