# Packaged Activity connection

Main's [native identity](identity.md) and [community connection](communities.md)
own account creation/import/restore, membership selection, admission recovery,
profile changes and ordinary relay writes. Activity does not choose an account,
read a legacy credential blob, export a key or fall back to the dev broker.

The former preview-only **Connect existing account** dialog and kind-9-only native
message adapter have been removed. Existing installations follow main's identity
setup; this merge does not migrate or overwrite credentials. Debug/release identity
items remain separate under main's policy.

## One identity, scoped Activity leases

The app-owned community connection opens an Activity lease after restoring the
public viewer. Rust checks that viewer against the ready `IdentityHost`, validates
the canonical HTTPS origin and independently discovers the NIP-11 `self` authority.
A contact `pubkey` is not authority evidence. The registry admits at most 32 leases,
with one pending/active lease per community origin. Failed/cancelled discovery
releases its reservation. Old close callbacks name the exact lease and cannot
close a successor or another community.

Signing and NIP-44 decryption borrow the same in-memory native identity. No key is
copied to a lease or exposed to JavaScript for Activity. Native-only decrypt accepts
an already verified telemetry envelope through the bounded observer/history paths;
there is no browser general-decrypt command. Main's deliberate identity import and
export controls retain their documented behavior and trust model.

Frontend cancellation retires its Activity view immediately, requests native close,
and fences late history/socket results. If native close fails, the cleanup handle
is retained; reconnect must retry it successfully before acquiring a replacement.
A failed native cleanup is not reported as successful deletion or revocation.

Window hide on macOS preserves the connection and agents. Actual destruction,
page reload and app exit revoke all Activity leases. Main's identity/community
restart policy remains unchanged. These lifecycle semantics require attended
packaged acceptance; source and synthetic tests are not proof of OS consent.

## Shared live transport and writes

The existing JavaScript live service remains the sole subscription, authentication
state, reconnect and retry owner. The native socket adapter replaces physical I/O,
not that policy. It supplies the native-observed NIP-42 challenge signer and verified
owner-visible Activity DTOs. There is no second Activity-only socket or timer.

Native limits remain: one opening/open/closing socket actor per lease, at most
1024 routes, 64 commands with 64 KiB checked before enqueue, 1 MiB frames, and
32 unacknowledged packets / 2 MiB. The terminal-close signal bypasses a saturated
packet queue. Observer routes are live-only and generation-fenced; plaintext stays
outside ordinary message/unread/cache reconciliation.

Main's HTTP query/sign/publish adapter, capabilities, profile/admission APIs and
old-event retry/readback policy remain authoritative. The live socket additionally
accepts signature-verified, exact-viewer supported EVENT publication, including
bounded kind-20001 presence, and forwards correlated relay OK receipts. AUTH remains
separate. No HTTP presence fallback or implicit signing-kind expansion is added.

Verified roster responses from main HTTP reads are delivered only to leases captured
before dispatch and still current on completion. They cannot seed a replacement
lease. Historical reads use their own bounded native query admission to refresh
signed roster evidence; this internal path exposes no second message-publishing API.

## Saved history and limits

[Saved Activity](activity-history.md) preserves original encrypted envelopes with
minimal public index metadata, bounded retention, scoped authorization, explicit
deletion and gap reporting. Storage location and schema are unchanged; old Buzz
archives are never imported or modified. Each history result remains separate from
live working/typing and message delivery state.

Development with a public viewer pin still uses the existing broker and live-only
Activity. Packaged Activity is wired through main's identity and community sessions.
No broker fallback is permitted in packaged mode. Protected media, uploads and
other capabilities are available only as documented by main's adapter, not implied
by Activity. Windows/Linux identity custody and attended package/restart/deletion
validation remain separate gates.
