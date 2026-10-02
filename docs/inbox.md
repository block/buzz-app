# Inbox: in-progress port

Inbox is a bundled page (`buzz.inbox/inbox`) that opens recent conversations
for the selected community. This intermediate stacked PR adds its conversation
UI; the dependent Drafts PR completes the user-approved Inbox batch.

## Evidence slice (stacked with Inbox UI)

PR3 added no Inbox UI. This page uses `session.unread.inbox()` as its single
conversation projection and `session.inboxFeed` as bounded addressed history
demand. These changes are one launch batch, not a separately shippable
backend feature. Ordinary channel and thread readers, read-state storage and
outbox retain their existing ownership. No projects, approvals or reminders.

## Conversation UI (PR4; Drafts in PR5)

Inbox now renders chat-only DMs, mentions and participating threads through
`session.unread.inbox()`, with independent Activity type and Sender filters and
an Unread only toggle. Sender classification uses `session.agentChoices` and
cached/profile-backed identity evidence, never a new inventory or name heuristic.
Rows retain exact IDs and current names while `inboxFeed.incomplete` marks only
specific group members awaiting their stored edit/deletion closure. Those rows
say “Preview updating…” or “Preview unavailable. Retry inbox.”; other rows stay
usable and the detail does not reveal an incomplete body. A failed read exposes
Retry above both panes, including narrow detail. This is a visible completeness
warning, not a guarantee that the relay did not change after verification.
Retry stays focusable while pending. Successful recovery returns focus to the
visible detail Close control (or the Activity type filter with no detail) only
if Retry still owned focus when its alert was removed; moving focus away is
respected. Revalidation hides and disables an already-admitted reader and its
composer without unmounting them; incomplete bodies remain outside the visible
and accessibility trees, and hidden content cannot earn read dwell. Recovery
preserves the visit and outside focus rather than replaying exact reveal. A
conversation-scoped presentation flag dismisses its open media/link previews,
source actions, and composer subdialogs; body portals cannot outlive withholding
or reopen automatically afterward. The main editor/draft and uploads stay alive;
unapplied link fields and unsubmitted report notes are discarded with their
subdialogs. A submitted report retains its operation and outcome without reopening
the modal; failure offers Review report after recovery. Pending send consent is
cancelled without undoing already-dispatched work. First admission still waits for
complete evidence, and lost access retires the reader. If withholding hides the focused reader control, visible Close owns
the temporary focus; recovery restores the same valid control only while that
handoff still owns focus. Moving elsewhere or deliberately blurring cancels it.
Inline audio/video pauses while withheld and retains its position; recovery never
resumes playback or replays an old pending seek. Explicit Play is required.

Opening a row captures channel, message and optional thread root, then uses the
existing channel window or an exact shared thread reader to reveal even an older
target outside the newest bounded page. A late verified root can regroup a
conversation without changing the captured visit or canonical origin. Reading
is saved by the shared unread owner; failed actions retain their captured Retry
unless the visit/access/session or a newer intent retires it. A DM Retry reuses
the original channel cutoff and manual-clear keys, not the retry-time clock or
later arrivals. Re-clicking the selected row preserves that visit and its retry,
even if reading changed the row's representative. Closing a pending multi-step
read lets its admitted save settle, then quietly cancels the remaining steps.
Genuine storage/access failures remain visible, without reviving the cancelled
Retry intent. Context menus allow device-local
Mark unread. Focus returns to the invoking row, a surviving row, or the persistent
Activity type filter on Close/Escape. Escape belongs to the detail, including in-head
DMs and incomplete previews; a keyboard-opened incomplete preview focuses its
visible Close control once per visit, without refocusing on placeholder updates.
Portalled media and controls retain their own dismissal. DM timelines share the
canonical reading/edit scope with their composer: a focused composer reads fully
visible arrivals after the normal dwell, without widening the captured selection
cutoff. Selected panes collapse by available Inbox width, including the sidebar's
space. Row accessible descriptions reuse the visible safe preview or incomplete
placeholder; Show more follows the filtered result count.
`NavigationItem` owns selected styling and `aria-current`. No Inbox-owned session,
parallel fold, composer or outbox.

## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history demand and exact incomplete-target metadata, not a row cache. Finite
results and live arrivals, edits and deletions use the existing session admission
and shared unread fold, so own/deleted messages stay absent and unresolved roots
never become duplicate conversations. Current membership gates the feed's
completeness targets and unread's rows; joining alone does not materialize
pre-membership history without fresh shared admission. Inbox renders those shared
conversation rows directly; there is no second project/approval row merge or
feed-owned reconciliation buffer and deletion-count abort. PR4 owns only
presentation, filtering and selection. No parallel signing or persistence is
added. Optional profile enrichment belongs to PR4; access, cache clear and
session retirement fence these projections. Opening Inbox does not mark rows
read; selecting an unread row does. Canonical Messages keeps its own reading
behavior.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Participation follows the shared unread owner's direct-parent policy,
including its existing bounded lookups for replies whose membership is undecided.
Fetched roots and participation witnesses remain structural, never extra Inbox rows.
A lookup-only root uses the existing exact-message manual-unread target until counted
root evidence arrives; its known root still supplies grouping and read-through.
Relevant replies remain thread activity even when the root cannot be fetched.
Multiple steps are not atomic: failures leave remaining evidence retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. Unread
retains at most 4,096 events / 8 MiB, observing up to 500 recent events per
128-channel roster batch. A lazy addressed query returns up to 50 kind-9/40002
messages. For those exact IDs and unresolved failed targets, general `#e`
queries page signed kind-40003 edits and kind-5/9005 deletions, then deletions
of the edits; `include_aux` on an ordinary `#p` query is not a supported relay
contract. Both auxiliary stages must finish before the feed is ready. Retained
unread evidence can be provisionally admitted between queries, but exact target
IDs are marked incomplete **before** unread subscribers are notified. The
consumer must not show their body as current while incomplete; failures retain
that metadata and offer retry. This is a completeness signal, not atomic content
admission or a second message fold. A target outside the latest 50 addressed
rows is not discovered; if a failed target falls outside a later page its
bounded auxiliary check still runs before its incomplete flag is cleared.
Incomplete obligations survive disconnect and unrelated access revocation while
the corresponding readable unread evidence survives; full cache/session retirement
clears both. Tombstone checks include retained author edits even if a later relay
query omits their soft-deleted rows. If reference visibility withholds an auxiliary
event, the finite attempt stays failed/incomplete rather than treating the filtered
page as exhausted history. Explicit Retry can settle it once existing shared
readers have admitted the missing reference; Inbox adds no reference-resolution loop.
Auxiliary reads cap retained results at 2,000 events / 4 MiB per stage; the shared reader
keeps its existing per-request deadline and cancellation. Missing roots,
participation or older activity can omit rows; an empty Inbox does not prove
complete history. No polling, independent row source or channel window is
opened for the feed. Access/cache/disconnect/disposal fence pending reads; local
read intent remains with unread. Packaged/native acceptance and human visual
feedback remain separate.

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Verification status

`inbox-feed.test.ts` exercises the real session reader/visibility/unread owners
with signed ephemeral events, including the first-admission subscriber ordering,
held edit and tombstone reads, failure/retry, reentrant access removal and cache
reset, root regrouping, and an edited addressed target older than 500 ordinary
messages. `unread.test.ts` retains the current main read/catch-up behavior and
adds Inbox projection/read-state cases. Neither file establishes browser paint,
real relay persistence or packaged/native acceptance. PR4's mounted real-session
`InboxPage.test.tsx` covers filters, read/retry and pending row/detail evidence.
`tests/browser/inbox.spec.mjs` uses the actual broker/browser in Chromium and
WebKit for exact focus, viewport/scroll, responsive failure recovery, canonical
origin and session-recipient publication. This is synthetic fixture evidence,
not human live or packaged acceptance.

### Review repairs

Incomplete obligations now survive lifecycle changes that retain readable evidence.
Closure includes retained author edits omitted by later relay queries and fails
visibly on withheld auxiliary evidence. Shared unread remains the sole row owner;
the unused feed row copy and its 70-deletion abort were removed with explicit
approval. A prepared channel-read intent lets the dependent UI retry the original
cutoff and manual-clear keys. Tests retain all prior scenarios, distinguish both
finite retention guards, and prove 71 admitted author deletions do not resurrect
rows or require a second reconciliation buffer.

Prior local tests and review cover the repairs on the combined tree; this PR's
updated head requires its own checks. No human/live/native acceptance or shipping
readiness is claimed.
