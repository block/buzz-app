# Existing-account native connection

This is the finite-HTTP slice for Apple Silicon macOS: an explicitly selected
existing account can open one relay endpoint for the current app session, read
channels/messages and send ordinary channel/thread messages through the existing
outbox. A native physical WebSocket now feeds the existing shared live owner, including
owner-visible Activity. [Saved history](activity-history.md) retains new native capture
in a separate encrypted-envelope store. Attended package acceptance is still open. No packaged live-account
acceptance is claimed by synthetic tests.

## Explicit caller

In the non-live native shell, **Connect existing account** opens the connection
form. Enter the account's public key (hex or npub, never nsec) and an existing
community's HTTPS/WSS origin. Startup, mount, typing and restoration do no
credential or relay work. Connect authorizes native custody and authenticated
reads; it does not join, enroll, publish a profile or change the old Buzz store.

The endpoint is labelled as checking access, then connected or unavailable.
Connection metadata is not channel membership. The session verifies relay-authored
rosters before participation and performs fresh mention preflight before sends.
The same account/origin continues to partition drafts, outbox and reading intent.
Only the connection itself is temporary: no saved auto-unlock or automatic startup
Keychain access. Recovery of previously queued messages follows the existing outbox.

Closing the dialog keeps the active connection. **Native account connection →
Disconnect native account** first retires frontend sessions, then awaits native
revocation. A failed IPC close retains the handle with a retry action and blocks
account replacement; the UI never silently forgets a held native identity.
Reconnection requires the explicit form again. Page reload/window destruction/app
exit revoke native leases independently of asynchronous plugin cleanup.

Supported writes are kind-9 messages and thread replies, including existing member
mentions. Reactions, edits, deletion/reporting, profile writes, uploads, joins,
invitations, read-state publication and broader broker parity are not exposed by
the native writer. Unsupported native community API calls fail locally rather than
contacting `/api/relay`. Profile editing says unavailable. Signed media is not
implemented; network images may have fallbacks. Live route state and Activity availability follow the real shared connection;
missing telemetry never proves an agent is idle. Browser and opted-in development-broker behavior is unchanged.

## Custody and commands

`src-tauri/src/account_connection.rs` owns explicit begin/run/cancel and a single
native account lease. Begin validates the public pin and canonical secure origin
before OS/network work, following `features/communities/destination.ts`:
HTTPS and WSS identify the same community; credentials, paths, query, fragments,
backslashes, ambiguous/insecure origins are rejected.

Only macOS's installed `buzz-desktop` / `secrets` item and its `identity` nsec are
accepted. Duplicate/malformed/oversized data, denial and exact derived-public-key
mismatch fail without agent-key, environment, file or alternate-store fallback.
`nostr = 0.44.7` matches the pinned Buzz runtime lock; only its `std` feature is
currently enabled. No handwritten signature implementation is introduced.

Public NIP-11 discovery has TLS, no redirects, a ten-second timeout and two-MiB
body limit. Explicit valid `self` stays distinct from contact `pubkey`; neither
alone grants membership. Only after verification/discovery does native transfer
custody into a random immutable-origin/viewer lease. Private keys never cross IPC,
enter arguments/environment, or get copied to a new credential store. Native
parsing creates transient memory copies; complete zeroization is not guaranteed.
The lease is removed on close; in-flight owners release their key reference when
cancellation/cleanup completes. No OS-screen-lock integration is claimed yet.

Generated Tauri ACLs restrict commands to the local main webview; native commands
also check its label. This is a trusted-app boundary, not sandboxing or proof of a
physical human gesture. Browser CSP is unchanged. No general signer, arbitrary
URL/header/method API, credential reader or decrypt primitive is exposed.

## Native I/O and delivery

`account_connection/session.rs` permits only:
- bounded, allowlisted finite filters to the captured `/query`;
- signing validated kind-9 templates;
- verified, same-viewer kind-9 publication to the captured `/events`;
- operation reservation/cancel and exact lease close.

Native builds fresh NIP-98 authorization from the actual fixed URL, POST method
and exact serialized body. Redirects are refused, transport deadlines are ten
seconds, query bodies are capped at64KiB and query responses at16MiB. Publication
receipts are bounded at4KiB; the existing frontend receipt contract validates
accepted/event ID rather than treating HTTP success as delivery. Six host operations
are admitted at once; operations expire before use, are single-use and are removed
on all terminal paths. No transparent POST retry exists.

The thin `native-transport.ts` adapter reuses shared admission/cooldown, signature
verification and the existing relay session/outbox. An optional writer preparation
hook reserves native capacity before the outbox publication phase. Cancellation
while reservation is held is unsent; late reservation results are disposed. Final
membership/admission checks run after preparation and immediately before publisher
entry. Once publication enters native IPC, losing its result may be uncertain.
Known native pre-dispatch refusal is `PublishRejected`, without erasing prior
unknown/accepted evidence on retry.

Native dispatch admission shares a mutex with cancel/close. Revocation winning that
admission prevents network entry. An already-admitted operation may still reach the
relay even if cancellation arrives before the request's first network poll; its
result is conservatively potentially sent. No claim of atomic relay membership or
network rollback is made. Cancellation interrupts awaits and fences returned data.
A delayed OS prompt cannot reliably be cancelled; credential admission stays occupied
until the actual read ends and cannot revive a retired connect ticket.

## Shared live connection

The existing `subscribeRelayTraffic` owns routes, authentication state and bounded
reconnection. Rust creates at most one opening/open/closing physical socket per
account lease and never retries independently. TLS uses native roots; URL derives
only from the captured origin. No redirect or arbitrary destination command exists.
Main-webview commands constrain REQ to the existing exact profile/membership/channel/
observer filters. Outbound EVENT is refused; HTTP remains the message publisher.
Presence publication remains unsupported rather than borrowing a general signer.

AUTH signs only the actor's bounded, once-per-socket observed challenge. The same
signed event must return through that same actor before requests are admitted.
Observer signature, exact tags, timestamp, and ciphertext/plaintext size are checked
before native NIP-44 decryption. Only a purpose-bound DTO from an admitted observer
wire crosses IPC; an observer event on another route never becomes ordinary traffic.
JS rechecks current socket/wire/demand and session access before capture.

Frames are capped at1MiB, outbound commands at64KiB/64 queued, and unacknowledged
inbound packets at32/2MiB. ACK follows handling and credits each sequence once.
Overflow closes with an out-of-band terminal packet; close/revocation stay reachable.
A replacement socket waits for actual previous actor cleanup. Only the shared JS
bounded reconnect policy retries. Historical replay is not part of this live route.

## Evidence and remaining work

Synthetic native tests exercise fixed-source custody, validation, deferred cancellation,
lease isolation/replay, actual registered sign/close IPC, real loopback NIP-98 POST,
no-redirect/oversize handling, dispatch ordering and post-entry cancellation. Real
Tauri ACL tests deny guest/remote origins. Tests compile live Keychain calls out.

Colocated tests use the real communities/session/outbox with an injected native I/O
boundary: activation without a broker, signed sends, fresh mention checks, exact root/
parent tags, close-failure retry, repeated disconnect cleanup, corrupt signature refusal,
and controlled reservation timeout versus dispatched uncertainty. Browser tests prove
modal keyboard/focus/light-dark responsive behavior with no OS or relay access. They
do not establish attended packaged network operation.

Socket tests additionally exercise a real loopback WebSocket handshake, native AUTH,
encrypted observer delivery, route teardown, invalid filters/signatures and queue bounds.
TS fixtures run the shared live/session owners with a fake native boundary, verifying
native observer routing, cache-generation reset and no chat reconciliation. These do
not substitute for production WSS or attended Tauri packet ordering.

The new-only native archive now supplies bounded historical reads and deletion;
see [its policy and acceptance limits](activity-history.md). Next is attended packaged
acceptance on the exact built candidate.
No old archive migration, whole-broker parity or live-account test is implied.
