//! Closed synthetic recipient for the fake-only manual checkpoint. No provider,
//! network, script, argument, environment configuration, filesystem or logging API.
#![forbid(unsafe_code)]
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use zeroize::Zeroizing;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Destination<'a> {
    community: &'a str,
    viewer: &'a str,
    channel: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request<'a> {
    operation: &'a str,
    body: &'a str,
    #[serde(borrow)]
    destination: Destination<'a>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input<'a> {
    attempt: &'a str,
    digest: &'a str,
    #[serde(borrow)]
    request: Request<'a>,
    fake_input: &'a str,
}
#[derive(Serialize)]
struct Ack<'a> {
    attempt: &'a str,
    digest: &'a str,
}
fn run() -> Result<(), ()> {
    if std::env::args_os().count() != 1 {
        return Err(());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(262145)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > 262144 {
        return Err(());
    }
    let input: Input<'_> = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if input.fake_input.len() <= 5
        || !input.fake_input.starts_with("fake-")
        || input.fake_input.len() > 128
        || !input.fake_input.bytes().all(|b| b.is_ascii_graphic())
        || uuid::Uuid::parse_str(input.attempt).map_or(true, |id| id.to_string() != input.attempt)
        || input.digest
            != format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&input.request).map_err(|_| ())?)
            )
    {
        return Err(());
    }
    // Only this exact acknowledgement can leave the private transport. Never echo
    // input or request, including on malformed input, and never recreate an attempt.
    let ack = serde_json::to_vec(&Ack {
        attempt: input.attempt,
        digest: input.digest,
    })
    .map_err(|_| ())?;
    std::io::stdout().write_all(&ack).map_err(|_| ())
}
fn main() {
    if run().is_err() {
        std::process::exit(1);
    }
}
