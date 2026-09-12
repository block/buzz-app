# Workflows capability and bundled UI handoff

Status: implementation contract, not a shipped or live-validated feature.
Wes approved session FOUNDATION wiring and workflow-only relay save/delete repair
on 2026-09-12 (Buzz event `768f982eb3295e1bcbc69614d61b38deb3dc608e62864a5c58df9d8453f7fac9`).

## Ownership and base

App baseline: `17f90c18fff6b86bc029e710401fb2b60bc385ea`.
Brain owns `src/features/workflows/**`, relay transport/outbox/session integration,
`dev/` host adapters, catalogs, dependencies, this document, and the separate
legacy relay repair. Pinky owns `src/bundled/workflows/**` and adjacent UI/helper
tests in a separate worktree. No shared live-tree mutations.

The type contract is [types.ts](../src/features/workflows/types.ts).
UI imports that capability by type and receives the captured session's
`workflows` property once integration lands; build/test UI compositions against
explicit fixture capabilities meanwhile. Do not implement an alternate host in
bundled code. Use the existing `pages` + `relay` injection and
`useRelayConnection`, not new plugins/author API or a router.

## First complete UI slice

- Channel-scoped **Saved configurations** list and raw YAML detail. Definitions
  expose canonical author/channel/UUID, signed event revision, timestamp and raw
  text. They do not fabricate runtime status or execution authority. `partial`
  signals the bounded query limit, not lifecycle verification.
- New drafts explicitly disabled. Message/reaction triggers; Send Message/Delay.
  Reuse pure legacy YAML/form/duration/schedule/condition/template helpers and
  their tests selectively. Use shared design-system components and read its
  stewardship instructions before composition. Preserve unsupported YAML and
  incomplete header edits; no rewrite merely on opening or changing selection.
- Save with existing definition for compare-and-swap; failed/conflicted/unknown
  writes retain drafts. Show accepted delivery separately from domain success.
  Delete requires confirmation and host availability; an old relay's generic
  accepted kind-5 receipt does not prove deletion.
- Manual run and bounded real run/trace next, before advanced editor polish.
  Only returned run ID correlates a run; never choose newest run as recovery.
  Approval rows are read-only; their hash is not an approval token.
- Form and YAML share restrictions. Webhook create/transition cannot bypass the
  one-time-secret capability. Never write secret into drafts, logs, ordinary
  journal, messages or clipboard automatically. Secret reveal is optional until
  its display lifecycle is tested; otherwise keep those saves unavailable.

## Read and write lifetime

Each read view starts idle; the UI subscribes and calls refresh on interest,
then disposes on unmount/selection change. It owns no background poll unless an
active-run detail is visible; pause on hidden and terminal state. Runs return one
20-row page with an opaque exact `(before,beforeId)` pair; dispose the prior page
before opening another. Never reconstruct the cursor from second-granularity rows.
Failures show retry and do not become empty, deleted or permission-denied guesses.

Views and operations purge before access-change callbacks. Remount by captured
scope + generation. Draft keys use stable community/viewer/coordinate, never
just channel/UUID; generation is not a durable key. Disable/unmount releases UI
interest but neither disables server workflows nor discards accepted intent.

`save`, `delete`, `trigger` return local signed-intent IDs synchronously; subscribe
to operations for outcome. The shared outbox journals intent/signature before
send. Event echo cannot cancel the only result-bearing receipt. Restored signed
intent never auto-runs; retry uses exactly that event ID and does not promise
recovery of lost secret/run receipts. Unknown outcome is actionable information,
not permission to automatically submit a new trigger. Bounded ephemeral result
state is separate from ordinary delivery persistence.

## Relay compatibility and unresolved historical state

The approved forward repair includes workflow save runtime/event transaction
consistency and timestamp-ordered atomic deletion using coordinate serialization.
It does not authorize generic command refactoring, blind old-delete replay,
destructive historical reconciliation, or a new lifecycle endpoint. Historical
configuration rows remain unverified; authorized runs reads prove presence only
at the read. A repaired forward-delete capability must be positively identified
before Delete is enabled. The exact host compatibility signal is implemented and
tested with that relay change; do not infer it from version strings or kind lists.

## Acceptance

Production-seam receipt ordering/duplicate/unknown tests; revision and permission
checks; access purge and A->B->A fencing; persistence and secret isolation; real
DB rollback/stale/concurrent deletion tests in the relay; UI keyboard/focus,
dirty-close/conflict drafts, narrow layouts and YAML ownership tests. Fixture
feedback can precede final package gates. Live identity/signing/destructive
workflow trials require a separate consented test, not this implementation approval.

## Host checkpoint (2026-09-12)

The app implements lazy structured history reads in both signed and dev-broker
hosts. The broker exposes only `workflow-runs` / `workflow-approvals` POST inputs,
constructs fixed upstream GET routes, preserves the exact cursor pair, and shares
the captured principal's API admission. History capability means the adapter
exists, not that an older relay serves the endpoint: failures remain explicit.
Responses are stream-bounded to 1 MiB before parsing; command receipts to 16 KiB.

All workflow writes remain unavailable in real host connections at this
checkpoint. Fixtures may supply `WorkflowHost.lifecycleVersion = 1` to exercise
commands. No real host advertises that evidence until the forward relay repair
and compatibility handshake are implemented and reviewed. Receipt tests do not
prove a deployed database transaction.

Revocation puts existing and newly opened denied views in `unavailable`, purges
all data before callbacks, and cancels late results. A regrant requires explicit
fresh interest; it never revives an old snapshot. UI must not reopen a recovered
private draft from an unavailable view. Secret reveal remains disabled.

A save receipt does not populate a read view. Refresh explicitly and match both
`operation.workflow` and `operation.eventId === definition.revision` before
permitting resave. A coordinate-only old/concurrent head is not save readback.
Generic kind-5 deletes retain their previous behavior: only workflow-coordinate
kind-5 operations use workflow validation and receipt semantics.

## Forward lifecycle advertisement (implementation checkpoint)

A repaired relay advertises the extension `buzz-workflows` in its host-scoped
NIP-11 document, alongside its explicit stable `self` key and:

```json
{"workflows":{"lifecycle":1,"host":"relay.example:8443"}}
```

`host` is the normalized, successfully resolved request authority (no scheme or
path; non-default port retained). The descriptor is absent when host resolution
fails or the relay has no stable identity. Revision 1 promises atomic forward
signed-definition/runtime saves and canonical, timestamp-ordered deletion with
retained cutoff proofs. Legacy name, numeric-kind aliases, definition-e-target
and admin-delete entrances reject; historical split state is not repaired or
certified. Authorization, moderation, schema fencing and execution remain relay
checks, not implications of this metadata.

The app requires all three fields: extension, exact numeric lifecycle 1 and
matching normalized host, plus a lowercase explicit `self` matching the session's
relay authority. No software-version, kind-list or contact-key fallback. Metadata
is fetched from the selected HTTPS origin without redirects, bounded to 1 MiB and
10 seconds. Missing/malformed/failed evidence never grants workflow writes.

Both signed and broker hosts discover per connection, and recheck before workflow
signing and publication (no retained positive compatibility cache). Broker session
DTOs project the validated descriptor; browser code validates it again. A downgrade
can leave old UI controls visible until reconnect, but signing/publication rejects
without sending the workflow. Broker signing permits only canonical owned
workflow operations through the same shared validator as the session. Webhook
saves and alternate deletion shapes are unavailable; ordinary message signing
remains unchanged. Metadata is a compatibility assertion, not a cryptographic
lease against a server replacement between the check and write.

The application’s real browser/native dev shell currently uses the broker;
`connectSignedTransport` is the alternative signer-owned adapter, not a claim
that native Keychain production wiring has been exercised. The new handshake
still requires independent review and an approved disposable live test. No
production deployment or real create/run validation is implied by this checkpoint.

## Host review follow-up (2026-09-12)

Workflow broker requests carry the connection's captured relay authority in
`X-Buzz-Workflow-Authority`. The broker requires a lowercase public key and checks
fresh host-scoped metadata against that value at both sign and publish. The pin is
not an authorization token and is never forwarded upstream; a new B connection
cannot rebind an older A connection. Identity changes require reconnecting.

The broker owns response-close cancellation before reading the operation body or
awaiting metadata, propagates it to discovery/admission, and checks it before
signing and dispatch. A late metadata result cannot create a new signature or
publication after cancellation. Already-dispatched writes retain unknown-outcome
semantics. Explicit numeric workflow coordinates (including leading zeros and
`+`) enter workflow validation, which rejects every noncanonical coordinate;
unrelated kind-5 event/coordinate deletes are unchanged in the signed adapter.
