# Me and sessions

Me is personal organization over ordinary channels, not a separate message store
or relay-enforced privacy mode. Signed channel membership remains access authority.
The earlier [channel-space proposal](spaces.md) is superseded design history.

## Current behavior

- Me placement and groups live in the existing encrypted, account/community-scoped
  `groups:me` preference record. Messages groups remain independent. Placement is
  explicit, not inferred from participant count or local agent availability.
- **Upgrade behavior:** Me starts empty. Existing sessions, including historical
  parent-linked sessions, remain standalone Messages rows. There is no automatic
  migration, membership revocation, nested creation or transcript copy.
- New conversations use ordinary private channels. The first send freezes the
  draft, channel ID, Canvas and group defaults in the existing pending-start
  receipt. Setup and Me placement must succeed before sending; retries reuse that
  ID. Draft settings remain local until first send and use Me's defaults namespace.
- Move to Messages preserves the channel ID, history, Canvas and memberships. It
  removes Me placement and the obsolete Me group assignment; it does not import
  the Me group into Messages. This is organization, not a privacy transition.
- Me sharing explicitly grants selected people access to the existing history and
  moves the conversation to Messages. Destination-link sharing in Messages remains
  a separate flow; see [sharing](sharing.md). Neither flow shares owner-private
  detailed agent activity or starts an agent merely by granting membership.
- Me uses the ordinary composer with selectable owner-scoped agent mentions. A
  send without a mention does not infer an agent. Existing Messages sessions keep
  their ordinary recipient rules. Saved placement must load before the Me reader
  enables sending; an unavailable preference read is not evidence of Messages.
- Canonical channel links still use the ordinary channel reader, and Me routes can
  refer to an accessible ordinary channel UUID. Routes and plugin views do not
  grant access. Disabling the Me view does not delete its channels or memberships.

## Organization, settings and recovery

Me groups, assignments and section defaults never fall back to Messages defaults.
Workspace folders, optional worktree/base branch and Canvas are instructions saved
in ordinary Canvas Markdown; saving settings does not create a worktree or change
an agent process. Templates are copied, not live-linked. Saved conversation
settings retain the existing Canvas revision checks and explicit conflict recovery.

Me uses one bounded 16 KiB recipe record, not unlimited history storage. Admission
checks its exact serialized size before remote channel creation and again before
saving placement. A full record keeps the draft and suggests moving an existing
conversation to Messages, which reclaims its placement and assignment bytes.
Admission is not a reservation: another device can fill the record between those
steps. Deleted/archived placements can still consume capacity. No cross-device
atomicity, automatic compaction or new multi-record storage protocol is claimed.

Share attempts retain in-process intent plus durable per-operation Outbox receipts,
not a persisted composite transaction. Start over forgets settled choices, not
submitted operations, created channels, confirmed access or Messages placement.
An interrupted link can be retried by its exact ID in Outbox; confirmed delivery
can be removed there before sharing to the same destination again. Unknown
receipts remain protected. Whole-share intent does not survive an app restart.

## Owners and validation limits

`src/bundled/sessions` owns Me navigation and its reused conversation/group UI;
`src/bundled/channels` owns Messages and Outbox recovery. Shared composition,
settings and share intent live in `src/features/sessions`; Me preferences use
`src/features/relay/me-preferences.ts` and the existing recipe capability. Existing
channel, membership, signing and Outbox owners retain their authority.

Colocated tests cover admission, frozen defaults, navigation lifetime and recovery;
browser fixtures exercise actual app wiring in Chromium and WebKit with synthetic
identities. They do not prove native signing, live persistence/restart,
cross-device/plugin fallback, real-agent effects or opening performance.
Those checks and renewed human acceptance remain delivery gates where applicable.
Me menu parity and Archive/Delete availability after Move are disclosed follow-ups,
not completed behavior in this baseline.
