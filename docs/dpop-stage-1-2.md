# Native session DPoP: stages 1–2

This slice adds optional device-bound native sessions to the existing private
issuer and macOS client. It does not enable any deployed population or change
human assertion claims. The configured 24-hour assertion lifetime and cached
assertion reuse remain unchanged. Relay proof enforcement belongs to stage 3.

## Configuration and wire contract

The issuer's optional `nativeDpop` configuration contains `publicBaseUrl`,
`schemaReady` (default false), and `enabled` (default false). Apply the nullable
`dpop_jkt` columns in pending OAuth logins, app codes, and sessions before
setting `schemaReady`. The public base is the HTTPS external origin plus every
gateway/API prefix. It must end with `BbidentityModule.pathPrefix`; all
proof-aware modules must use that same mount. Forwarded host headers are not
used to construct proof targets. `enabled` permits new bound logins;
`schemaReady` keeps existing bound sessions proof-aware during rollback.

The native authority descriptor optionally sets `dpop` to `secure-enclave` or
`software`. Only macOS implements this signer. Software mode is an explicit
weaker option; it does not claim resistance to copied private keys. Secure
Enclave mode checks the actual key token attribute, requires the platform
facility, and has no software fallback. A signed application with the required
Keychain entitlements must be verified before releasing that mode.

Login start sends the device thumbprint with the S256 handoff challenge. The
private issuer requests `max_age=0`, verifies signed IdP authentication time,
and preserves the thumbprint through a separate app-code hash domain. Exchange
requires a proof from that key before atomically consuming the code and creating
`NATIVE_DPOP`. It returns `token_type: DPoP` and the existing fixed expiry.
A lost exchange response requires starting sign-in again because the code is
one-use; it never falls back to a bearer exchange.

Session requests use `Authorization: DPoP <token>` and a new `DPoP` proof per
attempt. Human minting retains exact-body NIP-98 in `Nostr-Authorization` on
both routes. The legacy X-BB/Nostr profile remains separate. Agent enrollment
retains the owner attestation and agent Nostr proof, adding DPoP whose `ath`
covers the exact owner `subject_token`.

Proof verification accepts ES256/P-256 public keys, validates all target,
time, token-hash and key-binding fields, rejects ambiguous/oversized JSON and
headers, and rate-limits before signature verification. Replay claims use shared
Redis `SET NX EX 120` after proof and session authorization checks. Cache errors
fail closed with 503. Proof/freshness failures preserve usable sessions.

## Consumers

| Boundary | Bound session handling |
| --- | --- |
| Adapter exchange and session restore | Explicit proof-aware paths |
| Account read and logout | Explicit proof-aware paths |
| Both human assertion routes | DPoP plus the existing NIP-98 proof |
| Nostr current/challenge/verify/delete | Explicit action allowlist |
| Backup enrollment/upload/status/recovery | Explicit action allowlist; recovery requires fresh authentication |
| Agent owner enrollment | DPoP covers `subject_token`; agent proof unchanged |
| Legacy CLI/Bearer/cookie lookups | Reject `NATIVE_DPOP` |
| Hosted child credentials, Blox/Compose token issuance | Reject `NATIVE_DPOP` |
| Other shared-caller actions | Reject unless explicitly annotated |

Native plugin forwarding supports only the listed account, Nostr, and backup
status operations after its existing artifact/grant checks. Other consumers,
including hosted browser integration, Decisions, device pairing and public
onboarding, do not support the new session type. Do not enable a required
population that relies on those paths. Windows, Linux and mobile are outside
this slice.

## Freshness, retries, and lifecycle

Legacy human NIP-98 replay protection and sensitive-action freshness remain
behind default-off rollout flags. Ship compatible clients with unique proofs
on retries before enabling `humanProofReplayProtectionEnabled`.
`requireFreshBuzzAuthentication` also requires persisted verified IdP time.
Bound sessions always enforce freshness at sensitive boundaries and human
NIP-98 replay checks, independent of the legacy rollout flags.
A sensitive boundary accepts an IdP sign-in no older than the issuer setting
`buzzSensitiveActionMaxAuthAgeSeconds` (default and minimum: 1 hour). Bound
login itself still needs a sign-in from the last 5 minutes.

The storage identity is stable across bearer, software, and Secure Enclave modes.
A bound record stores a key handle and explicit key mode and uses a new version. Restore loads that
same key; key loss or a credential-mode transition requires fresh sign-in and
never reinterprets the token as bearer. Fresh login overwrites the same slot and
attempts to revoke the superseded credential, including one refused during restore.
Signing out removes that slot so rolling the mode back cannot restore an old session.
Session revisions fence derived work.
Rotation preserves the stored binding. Record removal, rollback and logout
check current secure-store references before removing a key. Recovery owns a
new key and a temporary session whose last native request owner attempts logout.
Remote revocation remains best effort when offline. Abrupt process death before
record persistence or persistent OS key-deletion failures can leave orphan keys;
there is no global startup sweep that might delete another process's login key.

## Verification limits

Database-backed production HTTP tests cover exchange, restore, downgrade,
strict proof failures, atomic redemption, rotation, both mint routes, agent
owner enrollment, and encrypted backup/recovery. A macOS Security.framework
proof fixture is verified through the real issuer HTTP boundary. The Redis
cluster test uses two independent cluster clients and a separate unreachable
production client for outage checks, leaving the shared cluster available.

The full native library has a pre-existing AppKit crash in a Tauri mock-window
test, reproduced at the unchanged base. Secure Enclave execution, a combined
native/issuer/relay workflow, deployed Redis eviction/failover, and relay
admission/load measurements remain unverified. Stage 2 assertions retain their
old format, so assertion-plus-Nostr-key theft is not prevented at the relay yet.
