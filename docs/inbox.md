# Inbox: in-progress port

Inbox is a bundled page (`buzz.inbox/inbox`), enabled by default. The sidebar
lists it through the plugin page's `primary` flag and opens it in the selected
community. The app navigation owner normalizes old `buzz.channels/channels`
Inbox routes to this page within the same navigation attempt. A disabled Inbox
uses the host's unavailable-destination recovery; selecting its sidebar entry
does not enable it.

## Available to try

- Two compact, independent dropdowns at every width: Activity type (All
  activity, DMs, Threads, Mentions) and Sender (Everyone, Humans, Agents).
  Unread only remains a separate toggle and wraps below the paired dropdowns
  in a narrow list. DMs use relay-identified channel type; Sender classifies
  the representative author, not all thread participants. Known choices or
  agent-marked public profiles count as Agents. Humans requires a valid,
  non-agent public profile; missing/malformed profiles remain in Everyone,
  never guessed as Humans. Profiles load for bounded activity candidates even
  when the sender filter currently has no rows. Classification uses already-cached
  profiles for every evaluated author, including beyond that enrichment page.
  All includes only these chat conversations. Project and approval activity are
  outside this Inbox slice.
- Incoming DMs grouped by channel; mentions and participating thread replies
  grouped by verified conversation. Each row shows its channel (#name) or DM
  participants in the same compact, muted highlight directly below the bold
  sender, without category tags; DMs show a text label without an extra icon.
  The lazy, finite viewer-addressed feed also
  supplies recent chat mentions. Own messages and generic
  channel traffic do not create rows. A mention may also match Threads.
- Stable conversation IDs, newest relevant activity ordering and the oldest
  observed unread message as the opening anchor (latest when read). Selecting an
  unread row opens inline detail and marks its verified observed prefix read; a
  failed read leaves the dot and shows an error with Retry above both panes,
  including when narrow detail hides the list. Hosts without frontier sync keep
  the dot. The DM and thread views reuse the shared timeline, thread panel and
  scoped composer. Normal threads, DM previews and selected drafts share the
  same rounded, lightly bordered conversation treatment with a compact header,
  scrolling real message history and one inset composer below it. DM titles
  and composer labels identify the actual participants. An icon next to the
  close control opens the exact canonical channel/thread target.
- The larger dot indicates unread status but is not a button. Right-click the row,
  or press Shift+F10 or ContextMenu while focused in the row for local Mark
  unread on a read row. No visible row overflow button is shown. Mark unread
  is disabled for already-unread rows and is device-only; reselecting
  the open row does not immediately undo it.
  Read rows remain available with Unread only off. During an explicit read action,
  rows are busy/disabled rather than accepting a selection whose read intent is
  dropped. A failed saved read/unread action offers an actual captured-action
  Retry; closing/retargeting, newer read intent or access/session retirement
  prevents replay. Already dispatched storage work still settles normally.
- Drafts is a quiet header action. Its list uses the Inbox row spacing and
  destination hierarchy; its detail names the channel or DM participants and
  distinguishes a message from a thread reply. Profile enrichment is optional,
  with public-key recognition fallbacks. The selected draft preloads the real
  shared composer, using its original channel/thread coordinate and ordinary
  session-owned admission, signing and outbox; typing saves to that same draft
  and Send publishes through the existing composer. Only the selected draft
  requests history: channel/DM drafts use the shared channel window, while
  thread drafts reuse one ThreadPanel and its existing root/reply reader, not
  a second composer or hidden gate-only reader. Channel previews start at the
  returned tail without reading or replacing the canonical saved scroll
  position. Empty, loading and failed history have distinct states and local
  retry. Thread replies require the exact saved root before composition;
  recovery disables sending without rebinding the draft to another root.
  The top-right Open in origin arrow navigates to the original conversation
  separately. Delete remains a
  small destructive action gated by confirmation; focus moves to the confirmation
  action and returns to the original trigger on Cancel. Storage failures keep the
  draft. The list remains usable beside the conversation (or above it when
  the Inbox column is narrow), with a bounded, scrollable history area. The
  inner close icon dismisses selection; Back to Inbox is the only page-return
  control. Returning to Inbox retains the Activity, Sender, and Unread only
  selections. Drafts are still enumerated
  from the existing viewer/community-scoped `buzz-view.v1` composer storage.
  Its 500-draft budget counts meaningful content, not empty composer history;
  truncation is disclosed. An emptied selected editor stays open until send,
  deletion or close, including thread drafts.

## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history and live reconciliation. Its admitted channel events contribute to the
shared unread fold, never a second raw row projection that could resurrect
own/deleted messages or invent unresolved conversation roots. Inbox renders these
shared conversation rows directly; there is no second project/approval row merge.
The feed retains its existing bounded chat snapshot and membership reprojection,
but that snapshot is not a separate row source or read-state owner. Arrivals and admitted
deletions during a finite read are reconciled inside that attempt's bounds and
generation. Inbox owns only presentation, filtering and selection. No parallel signing or persistence capability is added. Optional
profile enrichment is background work; access, cache clear and session
replacement fence the projections. Opening Inbox does not mark rows read;
selecting an unread row does. The canonical Messages view retains its viewport
reading behavior.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Multiple steps are not atomic: failures leave remaining evidence
retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. The unread
owner retains at most 4,096 events / 8 MiB and observes up to 500 recent events
per 128-channel roster batch; the addressed feed queries up to 50 chat mentions
(kinds 9 and 40002) in one finite request. No project or approval kinds are
requested. Missing roots, participation, or older activity can omit
rows; an empty view does not mean all caught up. The UI initially renders 50
conversations and Show more reveals the remaining rows in its current evidence.
A ready Inbox has no permanent Refresh control. Failure offers local Retry;
stale and idle views expose local actionable Refresh. After cache clear, an idle
view does not display a false spinner. Roster discovery/invalidation does not
start feed reads without demand; fresh Inbox demand or explicit Refresh recovers
idle evidence, and the existing reconnect callback refreshes only demanded feeds.
No channel windows are opened solely to
populate Inbox. Selected previews retain the shared focused-viewport dwell
reading behavior, so reading their history can update ordinary read state.

Thread previews inherit the shared reader integrated from main: supporting
relays open a verified newest-first window of 10 replies and demand-load older
pages of 50, up to ten retained pages. Inbox selection additionally retains and
reveals its exact opening anchor even when it predates that newest window.
A DM selected anchor uses the settled canonical channel head when present;
otherwise one existing exact ThreadPanel retains and reveals that message,
including older DMs and replies excluded from the top-level head.
A saved root draft opens newest context, never another root’s draft. Signed
window bounds, older-page retry and live reconciliation stay session-owned.

Legacy fallback remains oldest-first and bounded at ten pages of 50, only when
the initial probe returns verified replies without bounds. Its visible bottom
may not be the newest historical reply. Empty/failed/malformed window evidence
is retryable, never proof of an empty thread. See
[Viewing threads](channels.md#viewing-threads).

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Verification and trying it

Focused projection tests are in `features/relay/unread.test.ts` and
`features/relay/inbox-feed.test.ts`. Mounted real-session tests in
`bundled/inbox/InboxPage.test.tsx` exercise filter selection, opening-to-read,
local-unread context actions, read-state persistence and errors, exact navigation,
session replacement, roster recovery, selected-only history, draft retargeting,
loading/error/retry/empty states, exact synthetic channel/thread publication,
revocation/deleted roots, origin-navigation failure, and cache clear. Shared
ThreadPanel tests retain main’s mounted React history/recovery coverage and the
Inbox exact-root guard.
`tests/browser/inbox.spec.mjs` exercises the app/broker with ephemeral identities,
exact thread navigation, Back, right-click/keyboard local-unread actions,
matching preview borders/headers, visible context and bottom positioning,
scoped draft editing/publication, canonical scroll preservation, padding and
light/dark responsive layouts at 1280, 760 and 390 pixels in Chromium and
WebKit. The signed-window integration case proves an older exact anchor beyond
the newest ten remains focused, survives live arrival, and shows deletion
recovery; the saved draft uses the actual newest window. A separate DM case
proves an old selected unread target outside the top-level head is focused and
opens its exact canonical origin with one composer. These are fixture
checks, not live acceptance.

The chat-only reduction removes the two project-root-routing tests with their
removed implementation. Feed lifecycle coverage now uses chat events for the
same finite/live arrival, deletion, revocation, cache reset, reconnect, pending
disposal and membership transitions. Additional checks enforce one bounded
chat-only query and no project/approval Inbox rows. Existing composer, draft
storage, exact navigation, read-state and browser journeys remain.

In the agreed worktree, open the running isolated native Inbox Dev app (or its
printed local URL). Choose a community and Inbox. Try both dropdowns and Unread
only, then Drafts and Back to Inbox. Selecting an unread Inbox row changes real
saved read state under a live identity; use a disposable conversation if trying
that behavior. Opening a draft does not send it, but pressing the composer’s
Send button does, so use a disposable draft and recipient if trying Send.
Delete requires explicit confirmation and should likewise be tried only on a
disposable draft. Open in origin navigates to the original channel/thread.
Vite HMR updates the page; use Cmd+R for a stale native overlay. No app/cache
restart is needed for this UI pass.
