# Inbox: relay-authoritative exported surface

Inbox is a bundled page (`buzz.inbox/inbox`) for the selected community. It uses
`session.unread.inbox()` for rows and `session.inboxFeed` for bounded addressed
history demand. Presentation, filtering and selection belong to the page;
ordinary channel/thread reading retains its existing policy. No Inbox-owned
session, parallel fold, composer, signing or persistence is added.

## One authority, bounded candidates

`session.unread.inbox()` is a stable snapshot projection. The relay context
answer alone admits a verified candidate: it must currently be `unread` with
reason `direct`, `mention`, or `conversation`. Broadcast-only and null-reason
messages are excluded. Read/not-counted candidates disappear; there is no
retained read-conversation archive, historical reason cache, client participation
query, or relevance reconstruction. Signed ancestry supplies grouping, not
eligibility. A reply with an absent root can still target that signed thread.

Candidates come from the existing verified session cache (4,096 events / 8 MiB),
including finite addressed feed results. Inbox adds no second event map and no
all-channel history repair. Other session traffic can evict candidates. Cold
coverage is smaller than main's former dedicated unread retention. Eligible
kinds follow the relay-advertised set (v1 currently 9, 40002, 45001, 45003, not
40008). The relay's 30-day retention window governs verdicts; the client does not
reconstruct its cutoff.

Before folding, channels with exact-zero relay attention and no unread live hint
contribute no candidates when their row request started after their last cache
admission/invalidation. Queued, in-flight, failed or newer mid-request invalidations
remain unproven. Refreshing, stale or error status alone does not revoke a row's
proof or its leases; owner status still determines snapshot freshness.
`subscribeInbox()` retains at most 100 candidate selectors while subscribed.
An older mention can leave the Inbox once 100 newer foreign messages are cached
in channels with attention.
Notification/message subscriptions have priority under the existing shared
1,000-selector/context-lease bounds, displacing Inbox leases only when admission
would otherwise exceed capacity. Disposal releases Inbox demand. Reading
`inbox()` never starts a request. Existing sidebar refresh, invalidation and
lifecycle scheduling supply context answers; there is no new timer.

Missing, unknown and over-capacity answers omit those rows and keep the snapshot
unresolved (`freshness: stale` once otherwise observed), without an error.
Unavailable message/context answers and unaskable ancestry (cycles, excessive
depth or cross-channel parents) are skipped, not pending answers.
Only error status carries an error. Unknown never becomes read or an exact zero.
Context request failure follows the context owner's `status: error`, `freshness: stale`; earlier
confirmed rows may remain stale, while a first failure has no rows. Unsupported
or not-yet-requested state is idle/unknown. Ready/observed means the currently
bounded candidates have resolved verdicts, not a complete historical Inbox.

## Rows and reads

Rows group admitted DM messages by channel and other messages by signed thread
root or standalone message. `messageIds` and `unreadCount` describe only the
admitted, observed subset, not the relay's total conversation count.
`messageId`/preview identify its oldest unread member; `latestMessageId` and
`createdAt` describe its newest. The shared author edit/deletion fold supplies
bodies. Own and deleted content is omitted.

Manual journal marks overlay admitted rows only. A mark without a relay reason
cannot materialize a row and is not erased when its row is omitted. Read intents
use the existing saving/pending/applied coverage overlay and durable journal;
saving is not proof that the relay applied the operation.

`readThrough` contains one thread-prefix step for every distinct admitted
reply anchor. Author-time display ordering cannot discard an arrival operand. A thread prefix never acknowledges its top-level root. A standalone
top-level mention has an empty `readThrough`: **empty on a non-DM means no Inbox
read action**. Never substitute a channel prefix or an exact-message receipt
in that click action. This does not disable ordinary reader dwell: once a
standalone mention is shown, focused and settled, the shared reader can advance
the channel prefix through it, covering older top-level unread too.
DM rows also have no steps; their separate explicit channel action can use
`prepareChannelRead`. The page delegates these actions to the unread owner;
opening Inbox alone does not mark rows read. Hosts without `frontier-sync`
disable read mutations.

`prepareChannelRead(channelId)` captures the sidebar's latest-message ID,
current epoch and the manual-mark keys then present, once. Every invocation
reuses those operands. A mark on a key absent at preparation survives retries;
a re-mark on a frozen key is cleared by a subsequent invocation. There are no
journal mark versions. A complete empty channel permits only a local clear;
an unknown latest anchor rejects. Cache clear, disposal and access revocation
invalidate captured actions. No click-clock cut is invented.
`markChannelRead(id)` invokes that prepared action immediately.

`revision()` is the local journal's successful-intent save counter, not the
sidebar publication counter; reads, acknowledgements and sync refreshes do not
advance it. `generation()` exposes the current unread lifecycle epoch.

## Finite feed and preview completeness

`session.inboxFeed` owns finite verified addressed history demand and exact
incomplete-target metadata, not rows or unread authority. Its lazy query returns
up to 50 kind-9/40002 addressed messages. General `#e` queries page signed
40003 edits and 5/9005 deletions, then deletions of retained/returned author
edits. Both stages must finish before the feed is ready; each is bounded by
2,000 events / 4 MiB. Short authorized pages are not terminal; an empty page is.

Exact target IDs become incomplete **before** verified messages are published
to Inbox subscribers. Consumers must not show incomplete bodies as current.
Failures retain obligations and offer retry, including failed targets outside
the newest addressed page. This is not atomic content admission. Disconnect
and unrelated revocation preserve obligations for retained readable targets;
cache/session retirement clears them. Withheld auxiliary evidence fails the
attempt rather than masquerading as exhausted history. No reference-resolution
loop or participation repair is added.

Current membership/access fences apply to all rows, reads and publications.
Before joining, cached public messages create no demand or unresolved rows;
after joining, their relay verdict decides admission without replay or a join floor.
A finite feed completing does not imply context verdicts have completed. The
page subscribes to both capabilities and must honor both statuses. Neither
an empty list nor feed-ready establishes archive completeness.

## Conversation presentation

The page offers Activity type and Sender filters and an Unread only toggle.
The projection remains unread-only even with that toggle off; it is not a read
archive. “Unread only” is therefore inert, and the row menu's “Mark unread”
action remains disabled: every admitted row is unread. Both controls remain
visible pending the relay listing follow-up. Sender classification uses
`session.agentChoices` and cached/profile identity evidence, never a parallel
inventory or name heuristic.

Opening a row captures its channel, message and optional thread root and uses
an existing channel window or exact shared thread reader to reveal the target.
The captured visit survives removal from the unread projection; it does not add
a list row. Back/Close ends the visit. The existing detail handles unavailable
channel access. Exact readers repair the selected target's edit/deletion evidence;
channel windows repair only the bounded current head, not every retained older
message. A captured target outside that head can keep older content until another
read or live delivery returns its edit/deletion evidence. Readers handle deleted
or unavailable targets from the evidence they obtain, not from removal of an
Inbox row. Read retries are fenced by visit, access, membership,
generation and successful local intent
revision. A DM retry reuses its prepared sidebar anchor and manual-clear keys,
not the retry-time clock or later arrivals. A thread retry freezes remaining
steps and validates against still-admitted remaining IDs after earlier exact-ID
saves remove the original oldest member. Close/Escape retires undispatched steps,
not an already-admitted save. Manual unread remains device-local
and cannot independently restore a dismissed row.

`inboxFeed.incomplete` identifies exact group members awaiting edit/deletion
closure. Those rows show “Preview updating…” or “Preview unavailable. Retry
inbox.” rather than exposing an incomplete body. Retry is available above both
panes. Revalidation withholds an admitted reader and its composer without
unmounting them; hidden content cannot earn read dwell. The shared conversation
presentation boundary dismisses media/link previews, source actions and composer
subdialogs while preserving the main editor, draft and uploads. Inline audio
and video pause; recovery requires explicit Play rather than resuming playback.
Access loss retires the reader. Focus recovery respects focus moved elsewhere.

This edit/deletion closure covers addressed targets only. An unaddressed DM or
conversation reply can enter Inbox through unread evidence without a closure
obligation. Its row can show pre-edit text after a reconnect until another read
or live delivery returns the edit. Sidebar context refresh settles unread
eligibility, not body freshness;
a deleted original leaves the unread projection on a successful verdict refresh.
Removing a row does not close its captured detail or establish that detail's body
is current. Reconnect does not add a client-side content scan for these rows.

Detail uses the existing reader/composer and canonical origin. Close/Escape
returns focus to the invoking or surviving row, or the persistent Activity type
filter. Portalled controls retain their own dismissal. Pane layout responds to
available Inbox width. Row descriptions use safe previews or incomplete
placeholders; Show more follows the filtered result count. `NavigationItem`
owns selected styling and `aria-current`.

## Drafts

Drafts is a quiet Inbox header action. It lists only meaningful saved composer
text in this viewer/community scope, up to 500 with explicit truncation; an
emptied selected editor stays open until send, close or confirmed delete. The
list preserves the Inbox row hierarchy and supports channel, DM and exact-root
thread coordinates. Only the selected draft loads history through the existing
channel window or ThreadPanel; thread composition waits for a verified matching
root, and a deleted/malformed root never rebinds its saved text. The shared
composer and session outbox retain recipient, admission, signing and delivery
rules. A selected channel/DM draft opens at the real returned tail without
reading or overwriting the canonical saved scroll position. The origin action
navigates separately and reports failure without dismissing the editor.

The selected editor's lifetime does not depend on list-summary eligibility. Rich
saved envelopes use an 8 MiB preview bound rather than the former 128 KiB text-sized
cutoff; larger records receive an explicit notice instead of a false empty list.
The shared composer reconciles an untouched editor with saved changes from another
window. Locally edited documents remain in place with **Load saved draft** and
**Keep my draft** choices; Send cannot silently use a conflicted document.
Foreground revision checks also prevent an observed replacement being overwritten
by stale send cleanup. These checks are not a cross-window storage transaction.

Outbox acceptance and saved-draft replacement are separate outcomes. Drafts closes
after replacement succeeds, not merely after acceptance. If no draft was ever saved
and a fresh read still confirms absence, persistent write failure does not lock the
composer after acceptance: no stale sent text needs cleanup. A nonempty unsaved
agent follow-up stays editable with a save warning. Existing or unreadable saved
revisions retain the accepted-message recovery state and offers **Retry draft cleanup**, never another
Send of that accepted body. Recovery survives composer remounts within the same
session; it is RAM evidence, not a new durable receipt or a guarantee across app
restart. Existing outbox delivery/retry ownership is unchanged.

Delete is consentful and device-local. Confirm moves keyboard focus to the
actual destructive button; Cancel restores its trigger. After **successful**
scoped saved-text cleanup, the existing attachment-draft owner clears only the
same session/destination files and aborts its pending uploads. A failed text
cleanup preserves files and text for retry; sibling channel/thread drafts and
other viewers are untouched. Successful Close, Delete and saved Send restore focus
to the invoking draft row, another remaining row, or Back to Inbox; callbacks from
an earlier visit cannot retire a later selection. Failed Delete keeps its retryable
confirmation focused. This is not a new persisted index or migration.

## Validation scope

Colocated session tests cover verdict admission, local intent, bounded demand,
thread-only actions, frozen retries and feed edit/deletion/lifecycle closure.
They do not establish browser paint, real relay persistence, native acceptance
or human approval. Browser/hosted checks remain with the integration owner.
The incoming mounted `InboxPage.test.tsx` / `InboxDetail.test.tsx` and five
`tests/browser/inbox*` specs require validation against this relay-authoritative
contract; their presence is not evidence that the merged tests pass. Browser
fixture evidence also does not establish live relay or packaged acceptance.
`DraftsView.test.tsx`, `view-state.test.ts`, `attachment-draft.test.tsx` and
`tests/browser/inbox-drafts.spec.mjs` cover the separately owned draft lifecycle;
newly merged coverage needs validation on this integration snapshot.
Reminders, follow/mute policy and full backlog discovery remain out of scope;
this is not a full original Inbox port.
