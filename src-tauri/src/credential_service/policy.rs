//! The operation policy of the local credential provider contract (block/buzz
//! `docs/local-credential-provider.md`, Operation policy): what a caller's
//! token may have signed, decided from the complete unsigned event. Kinds are
//! block/buzz `crates/buzz-core/src/kind.rs`'s.
use url::Url;

/// How fresh an auth proof must be, either side of this clock.
const PROOF_WINDOW: u64 = 60;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    Sign,
    /// Signed only once the human approves it; refused for a caller nobody
    /// can be asked for.
    Ask,
    Deny(String),
}

/// Why a sensitive kind is refused to a caller the human is not asked for.
pub(super) fn unasked(kind: u16) -> String {
    format!("Kind {kind} can't be signed by a local tool; use Buzz")
}

const NIP42_AUTH: u16 = 22242;
const BLOSSOM_AUTH: u16 = 24242;
const NIP98_AUTH: u16 = 27235;

/// Auth proofs, signed only when bound to the token's community and made now.
#[cfg(test)]
pub(super) const AUTH_PROOFS: &[u16] = &[NIP42_AUTH, NIP98_AUTH, BLOSSOM_AUTH];

/// Everyday work: messages and their edits, pins, bookmarks, schedules and
/// reminders (9, 40002–40008), reactions (7), shared notes (30023), forum posts,
/// votes and comments (45001–45003), presence and typing (20001–20003), read
/// state (30078) and user status (30315), the identity's own lists (10000,
/// 10001, 10003, 10030, 30000, 30003, 30030), canvases (40100), artifacts
/// (45010), git patches, pull requests, issues and statuses (1617–1633), DM
/// open and hide (41010, 41012), archive requests (9035, 9036), workflow
/// triggers (46020), jobs (43001–43006), agent memory (30174), observer
/// frames (24200) and reports to the community's moderators (1984), which the
/// relay queues for moderators only and never acts on. A report, like a shared
/// note, binds to no community: one naming only a person (`p`, as
/// `buzz messages report --pubkey` sends) can be copied to any public relay
/// that honors NIP-56. That is accepted, as for 30023: it says no more than
/// the person reported here.
pub(super) const ORDINARY: &[u16] = &[
    7, 9, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 1984, 9035, 9036, 10000, 10001, 10003,
    10030, 20001, 20002, 20003, 24200, 30000, 30003, 30023, 30030, 30078, 30174, 30315, 40002,
    40003, 40004, 40005, 40006, 40007, 40008, 40100, 41010, 41012, 43001, 43002, 43003, 43004,
    43005, 43006, 45001, 45002, 45003, 45010, 46020,
];

/// Changes to who the identity is, what it controls or what others see about
/// it: profile and relays (0, 10002, 10100), contacts (3), deletions (5, 9005,
/// 45011), group admin, join and leave (9000–9009, 9021, 9022, 28936, 41011),
/// moderation (9040–9044), agent and team management (30175–30177, 30179),
/// workflow authority (30620, 46030, 46031) and repositories and projects
/// (30617, 30618, 30621).
pub(super) const SENSITIVE: &[u16] = &[
    0, 3, 5, 9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9021, 9022, 9040, 9041,
    9042, 9043, 9044, 10002, 10100, 28936, 30175, 30176, 30177, 30179, 30617, 30618, 30620, 30621,
    41011, 45011, 46030, 46031,
];

/// Sensitive kinds approved only once at a time: what they do is destructive,
/// grants privilege or is hard to undo, and names one target, so a window
/// for the kind would allow far more than the target the human saw.
/// Deletions (5, 9005), member additions and removals (9000, 9001), channel
/// edits, which can open a private channel (9002), channel deletion (9008),
/// bans, unbans, timeouts and their ends (9040–9043), report resolutions,
/// which can ban, kick or delete (9044), leaving the community (28936),
/// agent and team management (30175–30177, 30179), workflow authority and
/// step decisions (30620, 46030, 46031), DM additions (41011) and artifact
/// removal (45011).
pub(super) const ONCE_ONLY: &[u16] = &[
    5, 9000, 9001, 9002, 9005, 9008, 9040, 9041, 9042, 9043, 9044, 28936, 30175, 30176, 30177,
    30179, 30620, 41011, 45011, 46030, 46031,
];

/// Whether the human may allow a sensitive `kind` for a while, not just once.
pub(super) fn windowable(kind: u16) -> bool {
    !ONCE_ONLY.contains(&kind)
}

/// Known kinds that no local caller has signed: relay-authored events and
/// overlays (8000–8003, 13534, 13535, 39000–39009, 40901, 40902, 44100, 44101,
/// 46001–46012, 48001, 48104), relay membership admin commands (9030–9033),
/// public notes and legacy DMs (1, 4), gift wraps (1059), the app's own
/// builderlab challenge (24243) and other Buzz kinds not opened to local tools.
#[cfg(test)]
pub(super) const REFUSED: &[u16] = &[
    1, 4, 41, 1059, 1063, 8000, 8001, 8002, 8003, 9030, 9031, 9032, 9033, 13534, 13535, 24134,
    24243, 24245, 24810, 30178, 30180, 30300, 30622, 39000, 39001, 39002, 39003, 39005, 39006,
    39007, 39008, 39009, 40099, 40901, 40902, 41001, 42000, 44100, 44101, 44200, 46001, 46002,
    46003, 46004, 46005, 46006, 46007, 46010, 46011, 46012, 48001, 48100, 48101, 48102, 48103,
    48104, 48106, 49001,
];

/// The verdict for an event of `kind` with `tags` made at `created_at`, by a
/// token bound to `relay`, at `now`.
pub(super) fn classify(
    kind: u16,
    tags: &[Vec<String>],
    created_at: u64,
    now: u64,
    relay: &str,
) -> Verdict {
    let proof = match kind {
        NIP42_AUTH => Some(nip42(tags, relay)),
        NIP98_AUTH => Some(nip98(tags, relay)),
        BLOSSOM_AUTH => Some(blossom(tags, created_at, relay)),
        _ => None,
    };
    if let Some(bound) = proof {
        return match bound {
            Err(reason) => Verdict::Deny(reason.into()),
            Ok(()) if created_at.abs_diff(now) > PROOF_WINDOW => {
                Verdict::Deny("Auth proofs must be made now".into())
            }
            Ok(()) => Verdict::Sign,
        };
    }
    if ORDINARY.contains(&kind) {
        Verdict::Sign
    } else if SENSITIVE.contains(&kind) {
        Verdict::Ask
    } else {
        Verdict::Deny(format!("Kind {kind} is not signed for local callers"))
    }
}

fn nip42(tags: &[Vec<String>], relay: &str) -> Result<(), &'static str> {
    if !only(tags, "relay").is_some_and(|url| same_relay(url, relay)) {
        return Err("NIP-42 auth is signed only for this identity's community");
    }
    only(tags, "challenge")
        .map(|_| ())
        .ok_or("NIP-42 auth needs one challenge")
}

fn nip98(tags: &[Vec<String>], relay: &str) -> Result<(), &'static str> {
    if !only(tags, "u").is_some_and(|url| same_origin(url, relay)) {
        return Err("HTTP auth is signed only for this identity's community");
    }
    only(tags, "method")
        .map(|_| ())
        .ok_or("HTTP auth needs one method")
}

fn blossom(tags: &[Vec<String>], created_at: u64, relay: &str) -> Result<(), &'static str> {
    let host = Url::parse(relay).ok().and_then(|url| authority(&url));
    if host.is_none() || only(tags, "server").map(str::to_ascii_lowercase) != host {
        return Err("Blossom auth is signed only for this identity's community");
    }
    if !matches!(only(tags, "t"), Some("upload" | "get")) {
        return Err("Blossom auth is signed only to upload or get");
    }
    let expiration = only(tags, "expiration").and_then(|at| at.parse::<u64>().ok());
    if !expiration.is_some_and(|at| at <= created_at.saturating_add(PROOF_WINDOW)) {
        return Err("Blossom auth must expire within a minute");
    }
    Ok(())
}

/// Whether `a` and `b` name the same relay after URL normalization: one
/// host can serve communities at several paths, so the whole URL counts.
pub(super) fn same_relay(a: &str, b: &str) -> bool {
    relay_url(a).is_some_and(|a| Some(a) == relay_url(b))
}

/// Whether `a` and `b` name the same HTTP origin.
fn same_origin(a: &str, b: &str) -> bool {
    origin(a).is_some_and(|a| Some(a) == origin(b))
}

/// The value of the one `name` tag, or none when there is none or several.
fn only<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a str> {
    let mut found = tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name));
    let value = found.next()?.get(1)?;
    found.next().is_none().then_some(value.as_str())
}

/// A WebSocket URL, normalized: lowercase host, no default port, `/` for an
/// empty path.
fn relay_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "ws" | "wss")
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

/// A URL's HTTP origin, with `ws` read as `http` and `wss` as `https`.
fn origin(raw: &str) -> Option<(String, String)> {
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let scheme = match url.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    Some((scheme.into(), authority(&url)?))
}

/// `host[:port]`, lowercase, without a default port.
fn authority(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let default = matches!(
        (url.scheme(), url.port()),
        ("wss" | "https", Some(443)) | ("ws" | "http", Some(80)) | (_, None)
    );
    Some(match url.port() {
        Some(port) if !default => format!("{host}:{port}"),
        _ => host,
    })
}
