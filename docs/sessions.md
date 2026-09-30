# Channel Sessions: shared thread-backed V1 contract

Status: **bounded agent-thread Sessions and shared creation enabled, ready to try; user-reported live creation succeeded; independent live trace deferred, not full V1**.
Updated 2026-09-21 from the Sessions design discussion. Current-app inspection:
`333c4f287241868d9bb734ac466e98260c0a1824`. Existing Buzz inspection:
`4472da6491f7d76ebcffed4b65c341a3278aa25f`. Neither source inspection nor this
spec establishes deployed relay/runner behavior or live acceptance.

**Approval update, 2026-09-21:** the user approved the first fixture-backed
Channel/Sessions directory and existing full-width thread slice. FOUNDATION
permission is limited to the exact channel-directory contribution in conversation
`contracts.ts` and `service.tsx`. The broader product behavior below is unchanged.
The later approval extends only to the optional directory `create` contribution,
quiet-root marker and focused outbox support. Following final independent review
and parent authorization, shared creation is enabled as recorded in the final
checkpoint below; shared metadata and directory completeness remain future work,
not claims of this increment. The later all-thread preview was incorrect and is withdrawn by the agent-only
correction below. Bounded coverage is not a reduction of the full V1 contract.

**Scope correction, 2026-09-21:** Sessions is a new presentation of existing
channel threads, not a new agent execution system. The first draft incorrectly
made independent per-session ACP context and relay-wide transcript isolation
prerequisites. Neither was requested. Preserve current runner behavior and use
existing thread identity, messages, access and read state. Justify any backend
addition individually; a relay/runner redesign is not the starting plan.

## Coexistence with private Sessions

This document governs **channel-local shared, thread-backed Sessions** only.
The existing top-level IDE-like **[private Sessions](sessions/README.md)** experience
is complementary and unchanged: ordinary private channels, optional parent link,
independent memberships, saved private drafts, flat conversations, invitations and
its existing automatic-recipient rules remain its contract. A parent link grants
no inherited membership. This work does not replace or migrate that experience.

Within this document, “Sessions”, no implicit follow-up recipients, no ephemeral
channels and no private-until-shared state refer to the **shared channel mode**.
They are not instructions to remove private Sessions. The current channel sidebar
**New session** action still creates a private session; it is not the future shared
header-creation entry described below. Channel and private creation are not being
unified in this increment.

## Current app increment: bounded agent-thread Sessions

The existing `buzz.sessions` plugin contributes a **Sessions** tab beside
**Channel**, only in ordinary stream/forum channels. Its private top-level page
and manifest/native registration are unchanged. No tabs appear in DMs, private
session channels, metadata-unknown destinations or private draft views.

**Correction, 2026-09-21:** the all-human **Recent channel threads** preview was
wrong for Sessions and has been removed. The header is **Sessions**, described as
“Latest messages in checked history”, with a visible sampled-reply caveat. Only positive
exact-key evidence qualifies: a root author, unedited root's signed `p` recipients,
relay-signed summary participants, or a supported same-channel reply's author / exact
`p` recipients intersects `useKnownAgentPubkeys`. That helper combines current signed
profile `isAgent` display hints (self-declaration / auth-tag shape, **not verified
ownership, permission or membership**) with the already-loaded local library.
Names, prose, avatars and `agentEnvelope` alone never classify a session. Human-only
and unresolved candidates are omitted, never replaced with an all-thread fallback.

Candidate roots are current-channel actual roots with valid hex IDs and remote or
accepted/seen evidence. Unanswered agent mentions qualify; pending, failed and
unknown local root/reply intents do not. Root eligibility is recomputed from current
folded rows; ordinary edited prose does not inherit the original root's mention
classification. A valid quiet root retains its original marker and exact original
`p` recipients across edits. Author/participant evidence remains independent. Later human replies mentioning an
agent qualify before any agent response. This changes display, not invocation.

Only while the tab is mounted, one owned `session.observe` batch for the stable,
deterministically ordered selected root set requests kinds 9/40002 with exact `#h`
and `#e`, limit 200. The newest 200 loaded roots cap the filter; the UI discloses
truncation. Empty roots never issue a broad query. One foreground `refresh` uses the
existing reader; profiles enrich in background on demand, at most 1024 distinct
missing keys per opening, with no library read/poll. Profile/count-only changes do
not recreate the observer. Retry reruns the batch and missing profiles, never
per-thread observers. The shared observer owns retention/cancellation; local reply
classification processes at most 200 events. Existing owner reconnect refresh remains
unchanged. StrictMode-retired mounts do not dispatch their queued refresh.

`threadReference` must resolve the exact root and channel; arbitrary quote tags and
bare/lone-root references do not qualify. A nested reply naming only an intermediate
parent is unresolved by this batch. There is no recursive crawl or completeness
claim. Loading, unknown evidence, failed reads and explicit retry are visible.
Cache/access/session cleanup is owned by existing stores and mounted-generation
fences; eligibility is never a sticky cache. The shared channel window still owns
history refresh/load-older. No new socket, storage, startup scan or periodic work.

Ordering/date groups now use the latest **observed conversational message**:
`max(actual root.createdAt, supported shared sampled reply.created_at)`, with exact
root ID ascending for ties. Once a thread qualifies, human follow-ups advance it
too. Today/Yesterday/date labels and row times describe that observed time, not
thread start. Later calendar dates are shown as dates, not mislabelled Today.
Invalid/unrenderable timestamps are omitted. No summary receipt, edit publication,
reaction, profile, typing or telemetry time advances this value. Zero replies use
the actual root time. Sample eviction or cleanup can lower known recency; no sticky
maximum or additional journal is retained.

This is bounded ordering, **not** complete historical latest-message ordering.
The root cap still selects the newest 200 roots by creation, not by reply activity;
the one 200-event reply sample can omit busy/old conversations and unresolved nested
evidence. Existing refresh/older/retry/limit controls remain visible. No additional
query, subscription, timer or storage was added.

Selecting a root opens the existing full-width **ThreadPanel** without hidden
channel timeline/composer and without `sessionConversation` or `inviteAgents`.
Follow-ups use ordinary explicit mention intent; no recipients are remembered or
implicitly added, and selection never invites an agent. The existing transport,
thread access/read state, outbox and runner semantics remain authoritative.

Channels owns exact-registration/destination/access/connection command leases.
Same-channel selection, starting a private draft, navigation/session changes and
revocation retire old commands; late results cannot reopen a retired detail.
Label/profile updates do not allocate another reader or reset focus. Disabling the
plugin removes this contribution and its top-level private page through the existing
runtime; upstream direct private integrations in Channels remain as before. A
selected removed contribution has an explicit unavailable/return state and does not
resurrect on re-enable. New selection is required.

The original browsing increment added no writes. The subsequent shared creation
increment below now includes a domain-specific marker caller, with production
submission enabled after independent review and parent authorization. Rename, chips, participation
sidebar and activity correlation remain out of scope. Tests use isolated synthetic
identities, not the running native app or a deployed relay.

## Purpose and design references

Channels hold ongoing shared context; sessions hold individual pieces of work.
People should not need a new ephemeral channel for each task, nor load a large
session transcript just to read the parent channel. Sharing a session into the
channel is separate from conducting its conversation.

- [Sessions designs](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1357-15648): channel/thread, directory, session detail, inline activity and side-pane examples.
- [New Session draft](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1392-2554): a blank page under the channel's Sessions tab.

The six original screens and the blank draft were visually reviewed. Discussion
supersedes the original **Active / Past** list with a chronological directory.
This is a channel-local tab, **not a new top-level application destination**.

## Visual acceptance for this and future Sessions UI changes

**User requirement, 2026-09-21 at 17:07:** match the actual Figma design closely
now and in future iterations, rather than approximating Sessions as a stretched
thread panel. Review the relevant nodes before editing, then compare screenshots
of the actual implementation before handoff:

- [Session detail, 1357:14501](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1357-14501).
- [Blank draft, 1392:2554](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1392-2554).
- [Surrounding Sessions flow, 1357:15648](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1357-15648).

Use the shared design system's current tokens, components and type roles. Keep the
existing global navigation and sidebar. Preserve agreed product decisions over old
Figma placeholders: chronological rather than Active/Past grouping, existing
permissions, no invented people/agent counts or activity status, no fake controls,
and explicit agent recipients on every invocation. Record intentional visual
differences instead of silently approximating them.

Acceptance includes light/dark screenshots at narrow, intermediate and wide widths,
keyboard back/focus restoration, inline wide channel/tab navigation, a flat detail
with the actual root excerpt and a continuous message stream, and consistent
message/composer insets. Native running-app feedback remains separate from fixture
screenshots and automated checks.

The same feedback reported that creation worked and Blossom reacted with emoji.
It did **not** confirm a text reply. This is user-reported live feedback, not an
independently observed ACP trace or broader release acceptance.

## Agreed product behavior

### Shared work and context

- **Sessions are agent work; threads are general conversations.** Creating a new
  session requires explicitly addressing at least one agent in the first prompt.
  Human-only work uses an ordinary message thread, not a new session. An empty or
  unaddressed session draft stays local; sending prose alone cannot create one.
- Every current channel member can discover, read and participate in a session
  from creation. A quiet session is unannounced, not private.
- Every channel member can rename it; renaming is not creator-exclusive. Existing
  channel access remains authoritative. V1 has no Close/Reopen control or state.
- The session view begins with its own prompt and contains its thread conversation.
  Its agent can consult relevant parent-channel history on demand; this feature
  does not add a copy of the full channel transcript to each prompt. This is **not**
  a promise of a fresh ACP model context: existing channel-scoped runtime behavior
  is preserved.
- Explicit `@agent` selection is required to invoke agents on **every** message,
  including follow-ups. No remembered default recipient, single-agent implicit
  routing, or routing-mode switch when a second agent participates.
- Participation is not a grant to invoke an agent. Existing runner author policies
  remain in force. Do not silently change an owner-only agent to accept everyone.

### Three entry points, one directory

| Entry | Session behavior | Channel view in this app |
| --- | --- | --- |
| Existing `@agent` message | Preserve the current thread flow; include eligible agent threads in the Sessions directory. | Existing root and thread presentation remain unchanged. |
| Channel-header New session | Select Sessions and open a blank **New Session** draft with its own composer and a back action to the directory. | No announcement is shown. |
| Send `/session @agent <prompt>` | Create a thread-backed session with that prompt, show a session chip, then open the session. | Show the chip, not the full prompt/transcript. |

“Quiet” and “chip” describe this app's presentation. An ordinary root still exists
on the relay; older clients may display it as an ordinary channel message. No
cross-client hiding or new confidentiality guarantee is required. A durable,
validated presentation marker must survive reload and another member's view;
local-only hidden IDs are insufficient. The exact representation is not yet chosen.

The draft is local until first send. Opening or abandoning a blank page creates
no shared object or directory row. First-send pending/failure is local delivery
state, not evidence that another member can already see it. On acceptance, the
session is shared. Recovery must preserve the draft and any existing signed intent.

The initial title comes from the first prompt and is editable afterward; no
required naming step. A deterministic, bounded prompt excerpt is the proposed
first implementation, not a requirement for another model call.

An existing session offers **Share in channel**. This switches to its parent
channel's **Channel** tab, inserts the session chip into that channel's composer,
and focuses it so the member can add handoff text before sending. Existing draft
text is preserved; the chip is added, never substituted for the draft. The action
**never sends automatically**. No share dialog or clipboard step is required.
This is separate from the confirmed `/session <prompt>` send flow.

A chip points to the same conversation; it does not copy it, transfer a runner,
grant access, or create another session. Rename must not break its address. The
parent-channel sharing flow is in scope; cross-channel sharing and new DM Sessions
UI are not assumed. Existing DM/thread behavior is preserved.

Ordinary human-only threads are not sessions. **Explicitly addressing an agent
in a later reply brings the existing thread into Sessions too.** Preserve the
original root, all earlier messages and the channel's thread presentation; do not
copy, move or restart the conversation. This is directory inclusion, not an
execution migration. Reliable classification and historical coverage still need
the data contract below; display names or the viewer's saved agent library alone
cannot identify every eligible thread.

### Directory and sidebar

- The Sessions tab lists the channel's sessions, including eligible existing agent
  threads, in one timeline grouped **Today / Yesterday / earlier dates**.
- Sort/group by the latest conversational message, not telemetry, reading,
  or renames. Activity updates indicators without moving rows.
- Personal unread and authorized agent activity are independent row signals. A
  session can be unread and working simultaneously. No Unread/Active/Quiet sections.
- Working/quiet is not session lifecycle. Missing, stale, interrupted or inaccessible
  activity is unknown/unavailable, never evidence that an agent is quiet.
- The sidebar beneath each channel shows at most **five** sessions the viewer
  **started or participated in**, ordered by latest conversational message,
  followed by **View all sessions** leading to the channel's Sessions tab. The tab
  retains the full chronological directory, not just these five. Merely opening/
  reading one must not add it to the viewer's personal subset. Exact participation
  criteria remain below; no new Follow/Pinned feature is implied.
- There is **no Close/Reopen, Closed label or 24-hour aging state**. Sessions move
  into older date groups naturally; any member can continue one, and a new message
  brings it back to the latest group. No completion or archival workflow is added.

### Activity permissions and presentation

Keep the existing owner-only activity permissions, including derived activity
status. Channel membership does not authorize exposing another person's telemetry.
No new public presence feed is part of V1.

The intended presentation is an agent reply area in the conversation, rather
than activity under the composer, with progressive disclosure. “Bestie is thinking”
requires actual authorized, session-correlated evidence. Immediately after send,
a pending/awaiting presentation must not pretend the runner has started. Activity
must not become a fabricated signed message, unread response or chronology bump.

Inline activity presentation is a related, separately gated slice. Dragging activity
into multiple panes is a **separate layout workstream**, not a prerequisite for the
Sessions directory. The existing raw activity panel continues to work unchanged
until a replacement is implemented and accepted.

### Superseded ideas

Do not reintroduce Active/Past priority buckets, Close/Reopen, 24-hour state transitions,
automatic follow-up recipients, private-until-shared sessions, a channel-history
copy at creation, or blank drafts published to the shared directory.

## Current implementation evidence and gaps

### What the app can reuse

- [ChannelsPage](../src/bundled/channels/ChannelsPage.tsx) owns channel selection,
  sidebar, header, thread/panel placement and navigation.
- [Conversation contracts](../src/features/conversation/contracts.ts) offer composer
  tools, text/mention completions and plain-text inline renderers. Exact recipient
  intent and membership-checked [message delivery](../src/features/relay/messages.ts)
  already exist. Completion is not submission interception.
- [Navigation targets](../src/features/navigation/targets.ts) support scoped,
  versioned page routes and shareable locators. Prefer these over inventing another
  global navigation model. A parsed locator is not an access grant.
- The host [RelaySession](../src/features/relay/session.ts) owns reads, reconciliation,
  outbox, access and disposal. It means a community/viewer connection, **not** a
  product Session or ACP execution session. Keep those three identities distinct.
- [Thread views](../src/features/relay/threads.ts), shared message/composer UI,
  [read state](unread.md), profiles and appearance are reusable capabilities.
- Use the [shared design system](design-system.md#incremental-system-integration).
  Its InlineChip is presentation infrastructure, not a session protocol: its
  current address union has no session kind and does not replace host navigation.

The first slice adds a channel-tab directory contribution surface. There is still
no shared-thread sidebar-child contribution, complete shared session directory or collaborative
rename command. These are focused integration
or metadata gaps, not proof that a new conversation primitive is needed. Header
panel launchers currently toggle one bottom drawer, not the blank Sessions page.
Current shared composer drafts are scoped to channel/thread; shared-session drafts need
independent local identity until they have a root. Once created, the ordinary
thread root is the canonical identity and composer destination.

### Existing Buzz protocol and runner

All legacy paths below are pinned to the inspected commit, not claims about a
running installation:

| Finding | Source |
| --- | --- |
| Ordinary roots appear in the channel window. Nonbroadcast replies can be omitted from that window, but remain channel events; NIP-CW does not change storage/fan-out. | [NIP-CW](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/docs/nips/NIP-CW.md), [top-level predicate](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-db/src/thread.rs#L638-L650) |
| Replies require an existing same-channel parent/root. A fabricated missing root is not a quiet session mechanism. | [relay ingest](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-relay/src/handlers/ingest.rs#L813-L914) |
| Within a pooled agent instance, ACP session identity and delivery history are keyed by channel UUID. Queues, batching and in-flight handling are channel-scoped too. | [pool state](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/pool.rs#L109-L137), [session reuse](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/pool.rs#L1955-L1995), [queue](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/queue.rs#L92-L124) |
| Bounded thread context and channel-reading tools exist. Channel identity/context instructions are supplied to the agent. | [context fetch](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/pool.rs#L3277-L3318), [channel hints](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/queue.rs#L1353-L1389) |
| Agent invocation defaults to owner-only; channel membership alone does not authorize handoff to that agent. DM admission is additionally restricted. | [configuration](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/config.rs#L460-L468), [author gate](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/lib.rs#L251-L273) |
| Thread summaries include last reply time and at most ten recent distinct participants. They accompany windows, not an exhaustive session directory or personal participation index. | [summary contract](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/docs/nips/NIP-CW.md#L116-L135) |
| Thread read frontiers inherit the parent channel frontier. Unchanged thread markers do not guarantee independently read dedicated sessions. | [NIP-RS inheritance](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/docs/nips/NIP-RS.md#L175-L225) |

No collaborative session rename operation was found in the inspected relevant
handlers/protocols. The absence of a standalone session primitive is **not a blocker**:
use the existing ordinary root and replies. Do not create hidden ephemeral channels,
which would recreate the product problem and a separate membership lifecycle.

**Independent verification:** Eugene reviewed the existing root/reply model and
confirmed that presenting it as Sessions does not itself require a relay deployment
or independent ACP context. That source review did not establish an end-to-end
metadata scheme, efficient complete directory or arbitrary tag-filter compatibility.
Those remain explicit checks, not reasons to require a runner redesign.

Additional targeted inspection narrows two earlier overstatements:

- [Broker validation](../dev/relay-broker.mjs) (`validMessageTemplate`, lines 192–222)
  accepts string-array tags subject to channel and reply constraints; it is not an
  allowlist of all tag names. `messages.send()` does not yet supply session markers,
  and folded message rows do not project them. A bounded, versioned presentation
  marker on an ordinary root is a candidate app-level convention, not a chosen or
  validated protocol. Prove its persistence and read behavior through the existing
  ingest path before live use; do not claim all metadata needs a relay deployment.
- The runner already emits `turn_started.payload.triggeringEventIds`
  ([pool.rs](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-acp/src/pool.rs#L1769-L1782)).
  The [current activity projection](../src/features/agents/activity.ts) retains raw
  authorized frames but only exposes agent/turn/channel in its normalized state.
  Resolving triggering IDs to verified thread roots may supply correlation in the
  app without a runner change. Missing starts, unresolved IDs and multi-thread
  batches require unknown/ambiguous handling; a channel ID or ACP session ID alone
  cannot choose a thread. Live-only telemetry is not a historical directory.

### What may actually require deployment

| Work | Current conclusion |
| --- | --- |
| Session draft/tab/detail, root-as-chip or quiet presentation, existing thread replies and links | App work; the existing message model suffices. No relay or runner deployment inherently required. |
| Durable root presentation marker | Candidate convention over existing signed messages; app authoring/projection changes plus isolated transport checks. No demonstrated need for relay code yet. |
| Shared renaming | Unresolved persistence contract. Current message edit is author-only and cannot implement everyone-can-rename. Verify a legitimate existing capability or propose a small relay addition; local-only state does not fulfill the requirement. |
| Complete directory ordered by latest reply; personal participation across history | Existing windows supply summaries but page by root creation time; they are not a last-activity index. A full scan can collect old roots but must not block channel opening or masquerade as a bounded complete directory. Determine query feasibility before proposing an index change. |
| Owner-visible per-thread activity | First evaluate existing triggering-event evidence in the app; no runner change assumed. Do not fabricate correlation when evidence is missing. |
| Independent ACP history, queue isolation, cross-client hiding | Outside this presentation change. Existing behavior stays intact. |

Existing NIP-CW channel reads already exclude nonbroadcast replies. Session UI
may improve organization; filtering roots does **not** prove lower network cost.
Measure the reported long-thread opening problem and fix its actual owner rather
than making an unverified performance claim.

## Proposed implementation boundary

**Recommendation: extend the existing Sessions plugin over ordinary channel threads.**
Reuse the root event ID; do not introduce a parallel transcript or execution model.
The plugin needs focused app integration beyond today's registration contracts.
Backend work is conditional on a proven capability gap, not a prerequisite for
building the presentation. Scope expansion permits investigation; it does not pick
a wire format or authorize an unspecified FOUNDATION rewrite or deployment.

| Owner | Responsibility |
| --- | --- |
| Sessions plugin | Thread directory and full-page draft/detail presentation, rename intent and chip presentation. Shared controls wait for a real persistence contract. |
| Channels plugin | Channel-local tab/header/sidebar placement, filtered/chip root presentation, return navigation and unchanged ordinary Channel/thread views. |
| Shared host capability | Existing thread reads, references, authorization, outbox and read state; narrow metadata/directory projections as needed. No second socket, outbox or durable mirror in the plugin. |
| Relay/data layer | Existing messages, membership, queries and thread summaries. Change only for a demonstrated metadata or indexing gap, with a separately reviewed minimal proposal. |
| ACP runner | Existing mention admission, channel-scoped execution and reply routing remain unchanged. Reuse existing owner-visible trigger evidence where sufficient. |

Keep additions narrowly tied to this consumer: channel content/entry contributions
and a deliberate composer submission action, not a general workspace/docking SDK.
Do not route around the new shared-mode contribution lifetime by importing its
implementation into every host. Existing direct private integrations are unchanged.
Reuse contribution ownership/disposal. Disabled/replaced shared Sessions must not
break ordinary channels or leave stale commands; a retained unsupported destination
or chip needs a readable, explicit unavailable fallback, not silent redirection.

### Data contracts to specify before live writes

1. **Stable reference:** community, parent channel and existing thread-root event ID.
   Both entry types bind the same thread without copying messages. The local draft
   has a separate provisional key; replace it with the existing outbox/root identity
   on first send. No new event kinds or parallel session IDs are chosen here.
2. **Presentation/summary:** distinguish ordinary threads, quiet roots and chip roots
   with validated durable evidence. Derive initial title/creator from the root and
   last conversation time from verified messages/summaries. Shared title edits need
   a separate persistence decision; no open/closed metadata is required. Personal
   unread and participation are not shared flags on a root.
3. **Transcript:** reuse owned, bounded thread reads. Opening the directory must not
   mount a reader for every row. Current oldest-first traversal cannot guarantee a
   long thread's newest response within its cap; address that real read limitation
   separately rather than replacing the conversation model.
4. **Creation and announcement:** one ordinary root carries the actual prompt and
   exact invocation recipients. For `/session`, first evaluate rendering that root
   as a chip in Channel view and as the prompt in Session view: two views of **one
   send**, not an extra invocation. Header creation uses quiet presentation. Later
   **Share in channel** only inserts a reference into the existing channel draft;
   a separate message is published only when the member explicitly sends it.
   If a separate creation announcement is necessary,
   its failure/retry must not recreate the root or resend the prompt. Never copy
   invocation recipients into an automatic announcement. Unknown delivery retains
   its signed identity. Consume `/session` in the app, not in the harness.
5. **Collaborative mutations:** verify current authorization, define concurrent
   rename ordering, and recover failed/unknown writes visibly. Do not abuse
   author-only prompt edits or encode control traffic as ordinary chat merely to
   avoid a relay change; both can affect agents, unread and older clients.
6. **Execution:** preserve current runtime context, queues, batching, retries,
   admission and reply routing. A separate session page does not guarantee isolated
   model history or independent parallel agent work. No agent-stop controls or
   migration of existing execution history are included.
7. **Unread:** reuse existing thread targets and marker inheritance. Showing a
   directory/chip is not reading the hidden prompt/transcript; wire reading intent
   to what is actually visible. Explicit channel mark-read retains existing thread
   inheritance unless separately approved. No exact totals from bounded evidence.
8. **Activity:** validate and resolve authorized triggering event IDs to thread
   ancestry. Test batched turns, expired/missing starts and unresolved IDs before
   showing per-thread activity. Keep ambiguous details unassigned rather than
   attributing another thread's work. Preserve permissions, expiry, bounded RAM and
   lifecycle fences; never turn telemetry into a shared chat message.

Likely FOUNDATION touchpoints include `features/relay/session.ts`, conversation
`contracts.ts` / `service.tsx`, `plugins/api.ts` / `author.ts`, and possibly
`app/services.ts`. Page/panel contracts are also marked FOUNDATION; do not expand
them unless the chosen integration actually needs it. Supply the exact proposed
contract diff and request guidance before editing. The approval update above
authorizes only the exact conversation directory contract/service changes; the
other potential FOUNDATION touchpoints remain unapproved and unchanged.

Retain the existing React/TypeScript stack; no new framework, state library or
vendor is proposed. Tech Radar checked 2026-09-21: [React](https://dev-guides.sqprod.co/docs/tech-radar/blips/2024-04-15/2024-04-15-react)
is Adopt for Square, [TypeScript](https://dev-guides.sqprod.co/docs/tech-radar/blips/Q1/2025-Q1-typescript)
is Adopt for Block. No matching Tauri/Nostr/Cordis entry was found in the current
index; absence is neither endorsement nor rejection.

## Remaining decisions, not silent defaults

- **Legacy coverage:** define trustworthy agent-thread classification, directory
  backfill and title parity without a transcript crawl at channel open.
  Existing agent threads belong in the agreed directory. If complete historical
  coverage cannot be delivered, obtain explicit product approval for that scope
  reduction before calling V1 complete. Any partial/loading/error coverage must be
  visible, never presented as a complete list.
- **Participation:** recommend authored conversation messages as participation,
  not reading, mentions received or metadata edits. The sidebar limit is settled:
  five most recently updated personal sessions per channel plus View all sessions.
- **Incomplete slash input:** recommend bare `/session` open the local draft and post
  no chip. Only the prompt-bearing send flow has been confirmed.
- **Execution handoff:** use existing agent policies. Shared conversation is confirmed;
  universal ability to invoke owner-only agents is not. Reliable rejection feedback
  may need a runner acknowledgment rather than interpreting silence as refusal.
- **Activity slice:** test existing triggering IDs before proposing any producer
  change. Do not substitute channel-wide activity to make the design look complete.
  Multi-pane layout remains separate.

## Delivery sequence and acceptance

1. **Prove the narrow thread-backed path.** In isolated fixtures, author/read an
   ordinary root with candidate presentation metadata; reload as another member;
   resolve replies and a chip to the same root; preserve exact mention intent and
   outbox recovery. Prove metadata round-trip with the existing relay before live
   use. No production deployment or ACP rewrite is assumed.
2. **Build the presentation in an agreed Sessions worktree.** Channel-local tab,
   blank draft, existing full-page thread, root/chip presentation, chronology and
   personal sidebar. Request guidance for the exact FOUNDATION integration diff.
   Use fixture data for unsettled shared controls and label the preview honestly;
   a partial preview is not approval to drop confirmed V1 requirements.
3. **Resolve the few remaining data gaps independently.** Verify efficient directory
   ordering/participation, shared title persistence and trigger-based activity.
   If a relay change is needed, bring the specific gap, smallest change and trade-off
   for review. A client change and relay deployment are separate decisions.
4. **Integrate and try the real path.** Preserve ordinary threads, existing runner
   behavior and permissions. Add owner-only activity when correlation is sound.
   Check auth/signing/persistence and any new metadata semantics before live writes;
   iterate presentation without gating each round on the full scan.
5. **Validate the agreed batch.** Review risky shared contracts independently, then
   run contribution-workflow gates at a named snapshot. Live ACP and packaged
   acceptance remain separate from synthetic/browser results.

Required regression contracts:

- Two members observe the same accepted session and renamed title. On revocation,
  block new authorized reads/subscriptions/mutations and purge or fence app-owned
  cached data and in-flight results. Previously obtained copies cannot be revoked.
  Chip receipt never grants membership.
- Blank/abandoned/failed drafts do not pollute shared lists or overwrite channel
  drafts; scope switches and late completions cannot send into another destination.
- Share in channel opens the correct parent-channel composer, preserves its text
  and exact mention selections, inserts the existing session reference and focuses
  the composer without publishing. Only explicit Send publishes the resulting draft.
- Creation/rendering/share failure permutations and unknown outcomes preserve one
  thread root and one initial prompt. `/session` does not invoke the agent twice;
  retrying a later chip does not resend its original prompt.
- Existing root/reply IDs and ancestry are unchanged by switching between Channel
  and Sessions. Same-agent/channel execution, including current batching and context
  reuse, is not redefined; no isolated-context claim. Untagged messages introduce no
  new invocation path and existing runner subscription policy remains authoritative.
- A human-only thread gains one Sessions entry when an agent is explicitly
  addressed in a later reply, retaining its original root, prior conversation and
  channel presentation. Further agent mentions do not create additional entries.
- Thread-origin and dedicated entries do not duplicate a conversation when shared
  multiple times. Establish directory coverage against the agreed legacy backfill
  contract, including roots outside the loaded channel window. Old thread entry/
  navigation remains usable with Sessions disabled.
- Read/unread and activity remain independent of date grouping. Controlled clocks
  cover day boundaries and telemetry expiry; telemetry never reorders the directory.
- In a two-viewer fixture, the authorized owner sees correctly session-correlated
  activity; another channel member receives neither raw telemetry nor derived
  working/quiet status. Cache/access changes clear or fence old evidence; concurrent
  sessions cannot borrow each other's activity.
- With many sessions and a **300+ message transcript**, channel opening and directory
  opening must not fetch every transcript or allocate a thread reader per row. Hold
  optional directory/profile/activity work and prove channel messages still open.
- Retain the [cold/warm opening contract](browser-testing.md#channel-opening-performance):
  cold independence from held optional work; warm correct-channel display under
  100 ms with no extra head read. Measure queue/network/render separately where
  applicable; no raised budgets to conceal regressions.
- Deterministic Chromium/WebKit journeys for entry/navigation, keyboard-only use,
  light/dark and narrow/intermediate/wide layouts; use real host boundaries, not
  helpers alone. Failed reads expose retry, not permanent spinners.

## Ready-to-try workflow and validation boundary

Use the running native development app from `feature/channel-sessions-app`, based
on `4298460`, with the inherited public viewer setup. Open **Messages → an ordinary
channel → Sessions**. Review the agent-only results and bounded-history disclosure, select a thread,
close it to return to the focused row, then return to Channel. The top-level
Sessions page and channel sidebar New session continue the private workflow.
The user owns attended real sending/invitation checks; automated fixtures do not
perform live writes. The parent-supervised native build/launch succeeded as
recorded below; it is not proof of the native Messages/thread journey, live ACP or
packaged acceptance. Attended user feedback remains outstanding.

Focused execution evidence is recorded at handoff. Full scan/hosted CI, packaged
acceptance, live ACP and complete shared Sessions V1 remain separate gates.

### Historical pre-correction port evidence (2026-09-21)

Checked uncommitted source on `feature/channel-sessions-app`, base `4298460`:

- TypeScript, changed-file Biome (`--error-on-warnings`), design foundation/icon
  checks, relative documentation links and `git diff --check` pass. No shared
  design-system files, manifests, native registration, author/plugin APIs or relay
  owners changed; production adds no relay or native registration mutations. The
  only FOUNDATION additions are the approved conversation
  directory registry in `contracts.ts` and `service.tsx`.
- **167 tests / 20 Vitest files pass** (3.86s wall, 7.77s summed execution;
  slowest file the real Channels directory integration at 1.96s). Coverage includes
  the actual Sessions plugin's concurrent page/directory registration and removal,
  bounded shared-row projection, loading/error/retry, stream/forum vs DM/private
  restrictions, same-channel/private-draft retirement, held thread read revocation,
  focus/reader retention across labels, no hidden timeline/composer, and exact
  ordinary mentions followed by a recipient-free follow-up. Existing private
  creation/admission/recipient/window and workflow owners also pass unchanged.
- **Four Chromium/WebKit checks pass** (3.8s wall; approximately 6.3s summed,
  slowest 1.9s). Two new source-fixture cases, zero removed: one representative
  actual-plugin Channels → full-width ThreadPanel → private Sessions coexistence
  journey proves native keyboard focus, layout and independent directory scrolling;
  one layout case covers light/dark at 390/800/1280px. Behavior/failure matrices stay
  in RTL/service tests. No production fixture mode or standalone server was added.
  Narrow-light WebKit and wide-dark Chromium screenshots were inspected.
- The existing **cold/warm opening checks pass in both engines**, run serially
  (`--workers=1`, 6.7s wall). Chromium cold visible upper bound 39.5ms, warm
  42.0–47.1ms; WebKit cold 57ms, warm 41–63ms. Cold numbers include Playwright
  visibility roundtrip, not a pure render measurement. Optional profile work stayed
  held and warm switching issued no extra head read, below the unchanged 100ms
  budget. These are local Apple Silicon synthetic measurements, not a live SLA.

Commands (from the new worktree, pinned tools):

```sh
bin/pnpm typecheck
bin/pnpm design:check
bin/pnpm exec vitest run \
  src/bundled/channels/ChannelDirectories.integration.test.tsx \
  src/bundled/channels/useChannelDirectories.test.tsx \
  src/bundled/channels/ChannelsPage.test.tsx src/bundled/sessions \
  src/features/conversation/service.test.tsx src/features/sessions \
  src/features/relay/work-sessions.test.ts src/features/relay/session-window.test.ts \
  src/features/relay/session-agent-admission.test.ts src/features/relay/mentions.test.ts \
  src/features/workflows
bin/pnpm test:browser --project chromium --project webkit --no-deps \
  tests/browser/channel-sessions.spec.mjs
bin/pnpm test:browser --project chromium-measurements --project webkit-measurements \
  --no-deps --workers=1 tests/browser/channel-opening.spec.mjs
```

The source-fixture's mention preflight originally returned all channel rosters;
production correctly blocked the synthetic send. The fixture now honors exact
filters rather than weakening admission. Its inherited thread cursor correction
is retained and traversal assertions await terminal reader state. These fixes are
fixture evidence, not live protocol acceptance. No safety checks were bypassed.

Independent reviewer Eugene completed actual source review in task 38 and a final
sync after task 39, with approval and no blocker. The reviewer did not run tests.
At that earlier handoff, the source was unchanged after the focused checks above: 167 tests across
20 Vitest files, four browser checks and two cold/warm opening checks. This final
handoff update changes documentation only.

The parent ran supervised `bin/just desktop` in
`/Users/tulsi/Development/buzz-app-channel-sessions`. The actual Rust native dev
compile succeeded in **31.09s**, and
`/Users/tulsi/Development/buzz-app-channel-sessions/target/debug/buzz-foundation`
launched as PID **70281**. A screenshot of the native window's home view was
inspected, with the private Sessions navigation intact; the main frontend HMR
served the latest modules. The native **Messages/channel/thread journey was not
independently completed**. Attended user feedback remains outstanding.

The old `pulse-message-bubbles` development instance on port 1430 was stopped with
permission; installed Buzz and ACP were left intact. At handoff the new app
remains running under monitor state `channel-sessions-desktop`, with its log at
`/tmp/channel-sessions-desktop.log`.

Full scan, hosted CI, packaged acceptance, live ACP and the remaining shared V1
contracts are still deferred. The old fixture worktree is untouched. This final
documentation task ran only `git diff --check` for validation, with no source
changes, builds, tests, commits, pushes or live sends.


### Agent-only correction (2026-09-21)

The earlier all-thread preview and its classification disclaimer are withdrawn.
No backend, FOUNDATION, private Session component/recipient, native registration,
startup or ordinary channel-opening owner was changed for this correction. The
existing native app receives frontend HMR; no restart, native rebuild, commit,
push or live send was performed. Tests use synthetic signed identities only.

The existing two browser cases are updated, not multiplied: the actual plugin /
Channels / full-width ThreadPanel journey now proves human-only exclusion plus
root and later-reply agent mentions. Restoring old all-thread eligibility made its
human-only assertion fail in **both Chromium and WebKit**; corrected eligibility
passes. Layout, focus and private coexistence remain the browser-only contracts;
classification/error/lifecycle/cap matrices are colocated RTL and real-session tests.
Complete history, latest-conversation ordering, full scan/hosted CI, attended live
ACP and packaged acceptance remain deferred. Focused final check counts are recorded
at the correction handoff, not inferred from the earlier port results above.

Final correction checks on the uncommitted worktree at base `4298460`:

- `bin/pnpm typecheck` and changed-file Biome with `--error-on-warnings` pass.
- The focused command listed above, now including the colocated evidence tests,
  passes **182 tests / 21 Vitest files**: **4.23s wall**, **8.50s summed execution**;
  slowest file is the real Channels directory integration at **2.337s**. It covers
  exact root/reply classification, signed same-text edit invalidation, missing/failed
  profiles and retry, bounded requests, no normal-channel classification work,
  real cache/access/dispose fences and late-result rejection. Private tests remain
  unchanged and pass; ordinary thread follow-ups still add no implicit recipient.
- The existing two `channel-sessions.spec.mjs` cases pass in **both engines**:
  **4 checks**, **3.8s wall**, approximately **6.5s summed execution**, slowest
  about **2.0s**. Zero browser cases added or removed. Final narrow-light WebKit
  and wide-dark Chromium screenshots were inspected. This is local synthetic
  acceptance, not a live/native transcript or an apples-to-apples cost benchmark.
- Relative documentation links and `git diff --check` pass. No cold-channel owner
  changed; the focused real-host test proves zero classification batches before
  selecting Sessions and one batch after selection, including StrictMode. No full
  performance suite or native rebuild was run for this correction.

Independent reviewer Eugene returned **PASS, no actionable blockers** in task
`20260921_45`. This was a read-only source review; the reviewer ran no tests.
At **15:55 on 2026-09-21**, the user said **“looks good”** after trying the
agent-only correction in the running native app. This is attended feedback
acceptance of the bounded browsing increment, not an independently traced live
ACP exchange, shared-session creation acceptance or complete shared Sessions V1.

Scope remains bounded to browsing agent-mentioned threads in the available
history. The next shared **New session** flow remains a separate increment,
gated on its metadata and retry contracts. The historical checkpoints above are
unchanged; full scan/hosted CI, packaged acceptance, live ACP and the remaining
shared V1 contracts remain deferred.


### Shared New session safety checkpoint (2026-09-21, task 54)

**Gated, ready for independent review — not ready for live submission.** The first
edit restored `CHANNEL_SESSION_CREATION_READY = false` in `NewChannelSession`.
Only isolated tests inject `creationReady`; production registration does not.
Parent approval after independent review is required to remove the gate. The
existing native HMR process (reported PID 70281) was not restarted or exercised;
this task performed no live writes, native builds, commits or pushes.

Once separately enabled, the channel header **New session** opens a full-width
local draft in Sessions. Back preserves that draft independently of the ordinary
channel composer. Blank drafts and typed names alone create nothing. First send
requires an explicitly selected known current agent, then publishes one kind-9
root with exact `h`/`p`, stable `client-id` and `["buzz-session","1","quiet"]`.
The actual accepted root opens in the existing ThreadPanel. Follow-ups remain
ordinary replies with explicit recipients, never implicit agent re-invocation.
Private Sessions and DMs keep their current behavior.

Safety corrections from independent findings:

- An exclusive browser Web Lock named by scope/channel/viewer covers the
  re-read/claim, message-ID update and accepted-record cleanup. Only a fresh
  claimant sends; another window recovers the existing intent without delivery.
  Lifetime and current agent membership are rechecked after lock wait. Missing
  Web Locks fail visibly closed. Updates/cleanup check the expected draft UUID;
  stale completion cannot erase a newer record. An already-cleared accepted
  record still permits another window to open that same verified root.
- The existing bounded outbox retains its exact immutable candidate when initial
  persistence rejects, marks it failed/undispatched and attempts to save that
  status. Explicit retry reuses the same event ID, timestamp, content and tags,
  including the original emoji URLs. Restored retained intent never auto-sends.
  Unknown delivery stays unknown after dispatch. No second delivery journal or
  general raw-tag API was added. If persistent storage never succeeded and the
  process is lost, or retained intent is genuinely absent/evicted, recovery is
  conservative **Check saved session**, not a new root or automatic replay.
- Quiet hiding requires both a valid original marker and a positively known
  original `p` agent recipient. Unknown/nonagent roots stay ordinary. Existing
  full-window profile projection is retained; late profiles and actual profile
  budget eviction change presentation without mutating original rows. Plugin
  disable, exact-message navigation and explicit reveal retain readable fallback;
  private Sessions and DMs never use this quiet filter.
- Reading remains DOM-ID based. The real hook excludes hidden Q between A and B;
  the real unread service regression confirms dwelling B writes only `msg:B`,
  leaves Q unread and advances no channel frontier. No unread-engine change.

**Isolated protocol evidence:** `/tmp/channel-sessions-marker-proof.json` reports
PASS at `2026-09-21T20:24:42.306Z`, source-built old Buzz relay
`4472da6491f7d76ebcffed4b65c341a3278aa25f`, app base `3418bd9`. It exercised authenticated
creation/invitation/root admission, a teammate's exact signed query, exact stored
ID/content/tags/signature in disposable Postgres, same-signed retry producing one
stored root, nonmember read denial, and fresh-process/reconnect durable roundtrip.
This task read that artifact; it did not rerun the proof. It is **not deployed-relay
parity, app recovery acceptance, live ACP reply or exactly-once execution**.

Task 54 checks on its then-current uncommitted tree based on `3418bd9`
(superseded for the final claimant fix by the task 56 checkpoint below):

- TypeScript and changed-file Biome `--error-on-warnings` pass; `design:check`
  passes. No shared design-system source changed.
- **498 tests across 32 full affected Vitest files** passed on the final source
  in 5.66s wall / 22.26s summed execution. Slowest was `MessageComposer.test.tsx`
  at 3.102s. Coverage includes broker/domain/outbox,
  save-before/after-commit and receipt failures, retained restore/caps, membership
  fences, real React lifetime/claim/cleanup, quiet fallback and per-message read state.
- All four `channel-sessions.spec.mjs` cases pass in Chromium and WebKit:
  **8 checks**, 8.6s wall, approximately 14.9s summed execution (rounded reporter
  values), slowest 2.3s. The creation journey adds native editor/focus and quiet
  layout wiring; one additional two-page case proves actual origin-wide locks,
  shared localStorage and distinct outbox owners. Claims are held until both lock
  requests queue, not raced using sleeps; recovery ingests the same signed event,
  never corrupts an app journal. No browser case was removed. The cross-window
  case failed before correcting already-cleared acceptance recovery; unit tests
  cover the failure/status matrix. Screenshots wait for real tab/theme settling;
  final wide-dark Chromium and narrow-light WebKit screenshots were inspected.
- Existing cold/warm channel-opening cases pass in both engines (2 checks,
  6.8s wall). Warm samples were 41.0–50.2ms Chromium and 40–55ms WebKit, with no
  new head read and the unchanged 100ms budget. Cold visible upper bounds were
  34.4ms / 55ms and include the Playwright roundtrip. These are local Apple Silicon
  synthetic measurements, not hosted CI or a network SLA.
- The broker fixture initially returned unrelated metadata to a roster-only
  preflight; it now honors exact request filters. Production admission was not
  relaxed. Final full broker file passes.

Exact test commands use the pinned `bin/pnpm`; logs are under
`/tmp/channel-sessions-final-vitest.log`, `/tmp/sessions-final-newdraft.log`,
`/tmp/channel-sessions-final-browser.log`, `/tmp/channel-sessions-opening.log` and
`/tmp/channel-sessions-design.log`. Full scan, hosted CI, independent approval of
these fixes, deployed relay parity, attended native/live ACP and packaged acceptance
remain deferred. Full V1 still needs the separate rename/chip/participation,
complete last-conversation-ordered directory and activity contracts above.


### Stale queued claimant correction (2026-09-21, task 56)

**Production remains gated; ready for final independent review, not live use.**
Task 55 found one remaining ordering bug: accepted cleanup could erase the record
before an already-mounted losing editor acquired its claim lock, permitting a
second root. The task 56 correction is limited to the Sessions draft owner,
colocated tests and the existing cross-window browser journey. No FOUNDATION file,
production enablement, runtime restart, live write, commit or push was added.

A durable numeric editor generation is scoped by scope/channel/viewer. An opening
captures it before mounting its editor and initializes it under the same Web Lock;
Send waits for that initialization, while local editing remains usable. The lock
rechecks the captured generation, so cleanup during initialization cannot rebind
old input to a newer generation. Existing creation records take precedence and
always enter recovery without automatically sending. Accepted cleanup removes
editor storage, advances the generation, then removes the expected creation
record, all while holding the lock; any failed write retains the creation record.
Claims compare their opening's generation even when that record is now absent.
Retyping identical text does not refresh the mounted generation. A genuine new
opening can create a new intent. Expected-ID update/cleanup guards and post-lock
lifetime/current-agent membership checks are unchanged.

Final focused evidence on the uncommitted tree based on `3418bd9`:

- The deterministic mounted regression **failed before the fix**, producing two
  thread openings instead of one after cleanup queued before the stale claim
  (`/tmp/sessions-generation-before.log`). It now passes with exactly one
  published root, absent creation storage and a visible stale-editor failure;
  it also covers same-text ABA and a genuine new opening. Six mounted cases were
  added in total, including initialization ordering, editable loading, visible
  generation persistence failure and recoverable invalidation failure.
- TypeScript and changed-file Biome `--error-on-warnings` pass. The same **32 full
  affected Vitest files now pass 504 tests**, 5.28s wall / 23.08s summed execution;
  slowest file is `NewChannelSession.test.tsx`, 28 tests / 3.460s. This supersedes
  task 54's 498-test count, not its separate historical design/performance checks.
- The full `channel-sessions.spec.mjs` passes in Chromium and WebKit: **8 checks**,
  10.3s wall / approximately 17.1s summed execution, slowest 3.6s. No browser case
  was added or removed. Its existing real-page Web Locks/localStorage case retains
  pending-record recovery and now also proves cleanup queued before a stale claim,
  an absent record, and only one publication for that genuine opening. Lock queue
  inspection establishes ordering; no sleeps or retries were added. These local
  fixture runs are not an apples-to-apples performance benchmark or hosted CI.
- `git diff --check` passes. Logs: `/tmp/sessions-generation-types.log`,
  `/tmp/sessions-generation-final-vitest.log`, and
  `/tmp/sessions-generation-browser.log`. No cold-channel owner changed; the
  prior cold/warm evidence is unchanged, not rerun for this draft-only correction.

Final independent approval and parent authorization to enable creation remain
pending. Native user feedback on creation, deployed-relay parity, live ACP,
packaged acceptance, hosted CI and full scan remain deferred. The isolated real
marker proof above is unchanged and was not rerun.


### Shared creation enabled — ready to try (2026-09-21, task 58)

Eugene's final independent review in task `20260921_57` returned **APPROVE**
for the stale-claim blocker closure; task 55 had otherwise cleared the change.
The parent authorized final enablement following the user's full-flow approval.
These are review/authorization evidence, not attended acceptance of live creation.
The gated task 54/56 checkpoints above remain historical records.

The temporary production constant, `creationReady` prop and awaiting-review copy
are removed. The browser fixture now loads the actual Sessions plugin directly,
without a registration proxy or test-only creation override. The obsolete gated
component case is removed; the existing accepted-root test now explicitly checks
default production props. No browser cases were added or removed. Real Web Locks,
editor-generation fencing, permission/membership checks, busy/disabled state and
outbox recovery guards remain intact. Private Sessions and native/server code
are unchanged.

The isolated real-protocol artifact `/tmp/channel-sessions-marker-proof.json` was
read and still reports PASS for the exact quiet marker, signed admission/query,
durable stored event, same-signed retry, nonmember denial and fresh-process
roundtrip described above. It was not rerun. Task 56's 504 tests across 32 files
and eight browser checks remain the preceding broader focused checkpoint, not
a claim that those 32 files were rerun for enablement.

Final enablement checks on this uncommitted tree based on `3418bd9`:

- `bin/pnpm typecheck` passed.
- `bin/pnpm exec vitest run src/bundled/sessions/NewChannelSession.test.tsx`
  passed **27 tests in the full file**, 4.32s wall / 3.255s test execution.
  The count is one lower solely because the obsolete closed-gate case was removed;
  the default working-flow and all safety/recovery cases pass without opt-in.
- `bin/pnpm test:browser tests/browser/channel-sessions.spec.mjs --project chromium
  --project webkit --no-deps` passed **all 8 checks**, 10.2s wall / approximately
  16.9s summed execution (rounded reporter values); slowest was the WebKit
  two-window case at 3.6s. The unchanged browser-only contracts cover real plugin
  wiring, focus/layout and origin-wide Web Locks/localStorage across windows.
  This is a local fixture run, not a hosted timing comparison or live acceptance.
- Biome `check --error-on-warnings` passed for the three source/test files changed
  by enablement; `git diff --check` passed.

Logs: `/tmp/sessions-enable-types.log`, `/tmp/sessions-enable-vitest.log`,
`/tmp/sessions-enable-browser.log`. Earlier task 56 fail-then-pass evidence remains
the regression proof for the unchanged stale-claim logic.

Attended native/live creation, deployed-relay parity, live ACP response, packaged
acceptance, hosted CI, full scan and remaining full-V1 contracts are deferred.
This enablement task made no live writes, native builds, process restarts, commits
or pushes. The parent owns native-process verification and user try instructions.

### Figma parity feedback pass, 2026-09-21

Reviewed the actual detail (`1357:14501`) and blank-draft (`1392:2554`) PNG exports
and node context before editing. Shared Sessions now opt into a presentation-only
`ThreadPanel` variant: flat surface, root-content excerpt title, accessible back
arrow, continuous root/reply stream without a count divider, and a session-labelled
existing composer. The ordinary thread presentation and private Sessions are not
changed. Title/profile changes allocate no new reader. Blank drafts use the same
header and content insets, with one centered prompt and compact explicit-agent
instructions next to the composer; saved intent, failure and recovery controls stay.

The channel name and one shared Base UI tablist sit in an 80px wide header. Real
creation/actions sit at the right, with New session omitted inside detail/draft;
back returns to the directory and its launcher. Narrow layouts wrap tabs below.
Message and composer insets are 32px wide, 24px intermediate, 16px narrow. The
composer rests 24px above the panel bottom and is approximately 100px tall empty.

Intentional differences from the old Figma: retained host navigation/sidebar and
panel shell, actual prompt excerpts instead of invented numbered session names,
current design-system neutral controls and keyboard tab indicator, existing
message typography/timestamps/avatars, real available composer tools only, and
compact agent/visibility guidance. No fake attachment/format/headphone controls,
people/agent counts or activity labels. The current theme remains host-owned.

Local fixture screenshots cover 1512×982, 1280×850, 740×850 and 390×850, both
modes and both browser engines. The existing browser cases were extended, with
**zero cases added or removed**: they prove native focus, app/plugin wiring,
message/composer alignment and responsive header geometry, which jsdom cannot.
Creation and cross-window assertions remain intact. New mounted StrictMode
component coverage checks ordinary/session presentation, zero replies, held
loading/failure/retry, focus and single-reader disposal without mocking React.
This is ready-to-try evidence, not native/package/full-scan validation.

For this uncommitted visual snapshot based on `3418bd9`: root TypeScript,
changed-file Biome and `design:check` passed; **104 focused Vitest checks in seven
files** passed (4.38s wall, 6.72s summed test execution). The updated browser file
passed **8 checks** in Chromium/WebKit (13.4s wall, about 24.2s summed execution;
slowest WebKit creation/layout journey 4.7s). No browser cases were added or removed.
An intermediate specificity change was caught by the narrow-inset assertion in both
engines and fixed at the CSS owner; assertions were not relaxed. These timings are
local fixture evidence, not hosted CI comparisons. Logs are
`/tmp/sessions-visual-{types,biome,design,vitest,browser}.log`; screenshots are in
`test-results/browser/channel-sessions-*`.

No live writes, native restarts/builds, commits, pushes or full scan were performed
for this pass. PID 70281 remained running. Native attended visual feedback,
independent final visual review, packaged acceptance and hosted CI remain separate.

### Final visual review and recovery correction, 2026-09-21

Xela's task 61 visual review returned **PASS**, with the intentional differences
listed above accepted; the parent's own image review also returned **PASS**.
Eugene's task 62 source review found the visual changes safe but identified one
recovery defect: a restored creation record without `session.outbox` could leave
“Checking saved intent…” displayed indefinitely. This final correction reports
unconfirmed intent and unavailable outbox recovery, without claiming the prompt
was never sent. The existing explicit read-only **Check saved session** and
**Back to Sessions** remain available; there is no automatic read, resend or fake
activity. The ordinary composer continues its existing read-only behavior.

The session presentation now says “Loading session…”, “Retry session” and
“Session history limit reached.” Ordinary thread copy is unchanged. There are no
title/parser, relay, private Sessions or four-flow scope changes.

On this uncommitted tree based on `3418bd9`, the missing-outbox mounted StrictMode
regression failed before the correction and now passes. It asserts the settled
status synchronously, checks absence of checking/sending text, and exercises
read-only checking, uncertain absence, retained intent and Back without publishing.
The affected full component files pass **55 Vitest tests across three files**
(4.36s wall, 4.09s summed execution; slowest file NewChannelSession, 3.308s).
Root TypeScript and changed-file Biome pass. The existing browser file's single
loading selector now follows the session contract; all **8 checks** pass in
Chromium and WebKit (13.7s wall, approximately 24.2s summed execution; slowest
WebKit creation/layout check, 4.9s). No browser cases were added or removed.
These are local fixture results, not hosted CI or live acceptance. Logs:
`/tmp/sessions-finalfix-{red,types,biome,vitest,browser}.log`.

The parent's prior native feedback reported Blossom emoji without text. That
remains feedback evidence, not a newly observed live trace or a claim of a textual
agent response. Native PID 70281 is left unchanged for frontend HMR. No live writes,
process restarts, native builds, full scan, commits or pushes were performed.
Packaged acceptance, hosted CI and independently traced live ACP behavior remain
deferred. The task 62 correction has focused regression evidence and self-review;
no new independent review of that correction is claimed.


## Bounded conversational recency checkpoint, 2026-09-21

This increment supersedes the provisional **Started** ordering recorded in the
older checkpoint above. It reuses the already-mounted batch of actual signed
kind-9/40002 replies. Remote and accepted/seen shared intent qualify; sending,
failed and unknown local intents do not. A canonical marked root plus nested
parent is supported; bare/quote/lone-root/wrong-channel references are not.
Eligibility is unchanged, so a newer human-only conversation cannot create a row.
Roots and reply timestamps are safe nonnegative integer seconds within JavaScript's
representable Date range. Cache/session disposal drops the snapshot through the
existing owner, without persistent recency evidence.

**Source correction:** legacy Buzz at
`4472da6491f7d76ebcffed4b65c341a3278aa25f` updates `last_reply_at = NOW()` for the
**direct parent**, not `MAX(descendant.created_at)` for the conversation root:
[thread.rs, lines 210 and 262](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-db/src/thread.rs#L210-L283),
called from [event.rs, line 1292](https://github.com/block/buzz/blob/4472da6491f7d76ebcffed4b65c341a3278aa25f/crates/buzz-db/src/event.rs#L1292).
Root descendant accounting updates counts. That summary field is receipt evidence,
not an exact conversational timestamp; it is neither projected nor used here.
This finding does not justify a backend change for this bounded increment.
Complete-history ordering remains separate work.

The inspected reference is the
[directory frame 1357:15191](https://www.figma.com/design/uhFH3LPsy6HMqzoATFgWKl/buzz-?node-id=1357-15191),
with screenshot/design context at `/tmp/sessions-figma-directory{.png,-context.txt}`.
Compact 54px minimum rows, quiet dates and 32/24/16px responsive insets follow its
density and the existing session header. Intentional differences: agreed calendar
groups replace Active/Past; real reply counts and observed timestamps replace fake
LI-124 identifiers, green states and avatar counts; the existing ChatCircle icon
and flat groups remain. No close/status action is invented. The coverage notice
and functional history/recovery controls remain visible. Header/detail/draft and
host appearance are unchanged. Flat root-keyed list children preserve native
button identity and focus when a live reply moves a row between date groups;
there is no focus-restoration hook or focus stealing.

Focused validation and screenshot comparison are recorded below for this
uncommitted tree based on `3418bd9`, not inherited from earlier checkpoints.

Validation of this recency increment (local Apple Silicon, synthetic identities):

- Root `bin/pnpm typecheck`, changed-file Biome with `--error-on-warnings`,
  `bin/pnpm design:check` and `git diff --check` pass. No shared design-system
  source was edited.
- Full affected Vitest files `session-evidence.test.tsx`,
  `RecentChannelThreads.test.tsx` and `ChannelDirectories.integration.test.tsx`
  pass **43 tests / 3 files**, **3.69s wall / 3.09s summed execution**; slowest file
  is the directory integration, **2.482s**. Coverage includes human follow-ups,
  remote/accepted/seen versus failed/unknown/sending, nested/wrong/quote references,
  zero/older replies, ties, invalid/future dates, midnight rerender, actual signed
  root edits/summary receipt rejection, live session receive and cache clearing.
- The cross-day focused-row regression first failed with nested date groups
  (button remount), then passed with flat keyed rows. Browser native focus also
  passes in both engines during that reorder, with unchanged query counts.
- Existing `channel-sessions.spec.mjs` passes **8 checks**, Chromium + WebKit,
  **15.9s wall / approximately 29.1s summed execution**. Slowest checks are the
  layout journeys at **5.4s per engine**. No browser cases were added or removed:
  the existing wiring journey covers live reorder/focus/no extra read, and the
  existing layout journey checks 54px rows and responsive insets. The initial
  narrow layout failed at 55.97px; caption-role reply metadata fixed the owner
  without relaxing the assertion. Screenshot capture now waits for the host's
  actual final button colors, not an intermediate theme transition. This adds
  observable settling time (the preceding run was 13.1s), not product work.
- Light/dark screenshots at **390, 740, 1280 and 1512px** were captured in both
  engines. The 390/740/1512 light/dark views were inspected against the Figma
  directory frame; final WebKit captures confirm settled colors. Intentional
  differences are listed above; this is not a pixel-identical Figma claim.

Logs: `/tmp/sessions-recency-{red,types,biome,design,vitest,browser}.log`.
Screenshots: `test-results/browser/channel-sessions-fixture-l-c98f8-row-intermediate-wide-views-{chromium,webkit}/sessions-*.png`.
The parent may seek independent review; none is newly claimed here. Full scan,
hosted CI, native compilation, packaged acceptance, independent live trace and
complete-history ordering remain deferred. No startup/channel-opening owner
changed, so no cold-opening performance check was repeated. No live send,
restart, commit or push was performed; native PID 70281 remains under the human's
control and frontend changes are ready for HMR feedback. To try the change, keep
Sessions open and have a reply arrive in an older eligible conversation already
inside its checked sample; its row should move to the latest observed date/time.

## Share in channel — 2026-09-22 checkpoint

On the uncommitted Share tree based on `df04c96`, the Session detail header now
has **Share in channel**. It returns to Channel, appends one escaped canonical
reference to the retained draft and focuses the composer at its end. It does not
send, invite an agent, copy a transcript, change ownership, or create another
session. Existing draft prose and exact mention recipients remain intact; the
append is one Undo step. Publication still requires explicit **Send** and uses
ordinary kind-9 channel content with only the draft's selected recipients.

The chip is presentation over an ordinary viewer-free Buzz conversation link:
channel plus matching message/root IDs. Opening a published chip uses the existing
**Thread** navigation, not the Sessions detail presentation. Copy/paste retains
the canonical Markdown source. Double-click opens that source for editing; Undo
restores it. Links-disabled fallback remains an ordinary readable link.

The host retains only the channel draft owner while a directory is selected; its
editor, tools and emoji demand are suspended. The handoff is host-only, not a new
plugin command. Source-read failure, revoked destination/access, interrupted IME,
unsupported writes and overlong drafts reject the append. A conflicting saved
draft latches editing/send/share off without overwriting either text. Returning
to Channel shows the local text and a saved-draft disclosure; **Load saved draft**
requires explicit review and keeps the previous local text available with Undo.
Malformed/unreadable storage offers retry, never a silent empty reset.

Presentation follows the approved Xela5 direction: regular Phosphor
`ClipboardText`, 16px artwork in a 28px tile, a 44px chip and 8px left / 24px right
insets. The host remains the appearance owner. A character of editor-only width
is reserved for the trailing native caret/space at narrow widths; published chips
retain the normal width constraint.

### Checked snapshot and regression evidence

Local Apple Silicon checks on this uncommitted tree (synthetic identities only):

- Root `bin/pnpm typecheck`, changed-file Biome (**21 source/test files**, no
  warnings), and `git diff --check` pass.
- Full affected Vitest files pass **177 tests / 8 files**, **4.21s wall / 6.89s
  summed execution**. Slowest file: `MessageComposer.test.tsx`, **2.995s**.
  These include the actual directory integration, composer lifecycle/conflicts,
  thread presentation, link rendering, reference serialization and DOM offsets.
- All four required design scripts pass: `design:typecheck`, `design:check`,
  `design:test` (**42 tests / 8 files**) and `design:build`. The build retains
  Vite's non-failing large-chunk advisory; no limit was changed.
- Full `channel-sessions.spec.mjs` and `composer-links.spec.mjs` pass in Chromium
  and WebKit: **14 checks**, **23.1s wall / 42.8s summed test execution** (rounded
  reporter durations); slowest case is the Chromium layout journey, **5.4s**.
  Two browser scenarios were added, none removed: actual rich-editor
  selection/copy/paste/Undo, responsive geometry and signed publication wiring;
  and two real pages sharing storage while retaining independent editor state.
  The latter proves conflict propagation, edit blocking, explicit recovery and
  recovery Undo/redo. Neither native selection/layout nor cross-page storage
  propagation is inferred from jsdom. Lower-layer failure matrices stay in
  Vitest; no retries, timeouts, tolerances or assertions were relaxed.
- Fail-then-pass: Share exposed a native-paste selection exception (the mapper
  assumed a zero-width boundary survived replacement) and WebKit's narrow
  inline-object/caret overflow. The mapper now counts the boundary only when
  present, in both relevant positions. Its new four-case DOM regression fails
  **2/4** against the original mapper and passes **4/4** with the fix. Both Share
  browser cases then pass with canonical text, exact recipient and page-error
  assertions intact. The original broad browser attempt also timed out in
  existing journeys; the full final files pass, without claiming all flakes
  eliminated or attributing those unrelated timeouts to a proven source cause.
- Existing cold/warm channel-opening checks pass serially in Chromium then
  WebKit, **2 checks / 6.9s wall**. Cold click-to-visible upper bounds were
  **40.7ms / 48ms** (including Playwright assertion overhead); browser-clock warm
  ranges were **37.2–41.6ms / 41–44ms**, below the unchanged 100ms budget, with no
  new warm head read and optional profiles still held. Exported evidence keeps
  reader queue, broker admission/network and verification/render timings; these
  are local fixture measurements, not a live-network SLA.

Logs: `/tmp/session-share-{typecheck,biome,vitest,browser-final,opening}.log`,
`/tmp/session-share-design-{typecheck,check,test,build}.log`, and
`/tmp/session-share-dom-{red,green}.log`. Final Share screenshots for light/dark
390/740/1280px in both engines are preserved under
`/tmp/session-share-browser-artifacts/channel-sessions-Share-*/share-*.png`;
opening timing exports are under `test-results/browser/channel-opening-*/evidence.json`.
Xela's final synchronous visual review returned **PASS** after inspecting the
actual final Share chip PNGs: **1280px light Chromium** and **390px dark WebKit**.
The 44px chip rather than the reference's 42px is an intentional design-system
choice. The parent also inspected both images and confirmed no overflow. This is
visual review evidence, not an attended live Share try or a new test execution.

Per the parent handoff, Eugene8's read-only source review passed and closed all
prior IME and cross-window-conflict findings. Eugene's final synchronous read-only
review after task 11 also returned **PASS**, covering the later conditional
zero-width-boundary DOM-offset handling and editor-only CSS scope. These reviews
do not add test executions: the coder's **177 unit, 14 browser, 42 design and 2
channel-opening checks** above remain the recorded execution evidence.

The parent verified native PID **70281** still running and the frontend module
returning **HTTP 200**. Attended live **Share in channel** remains pending user
feedback; process/module availability does not establish that behavior. Full scan,
hosted CI, packaged/native acceptance and an independently captured live ACP trace
remain separate/deferred. No live send, backend/Foundation edit, explicit app
restart, commit or push was performed. This final handoff update is documentation
only; no source changes, builds or tests were run for it.

### Deferred UI feedback — 2026-09-22, 08:48

Defer a dedicated UI pass for all session buttons: hierarchy, spacing and states.
Session names also need a concise, meaningful title/excerpt rather than a verbatim
160-character root excerpt, which can expose long agent error text in the header,
directory and Share chip. Review width-aware truncation and accessible full-title
disclosure together in that later pass. This records feedback only: no title
logic or UI changes now, and no model/API diagnosis or model change is part of
this task. No screenshot or live conversation data is copied into the repository.


## Channel `/session` — gated checkpoint, 2026-09-22

On the uncommitted tree based on `df04c96`, explicit Send of a leading `/session`
in an ordinary channel strips only the command prefix and preserves selected
exact `@` recipients. Typed names do not select agents. Bare/invalid/unavailable
commands fail visibly, without falling through to ordinary send; thread text stays
literal. **Production `sessionCommandValidation.enabled` remains false pending
parent approval.** Only synthetic tests opt in; the marker proof does not enable it.

The result is the actual kind-9 root with `h`, exact `p` and
`["buzz-session", "1", "chip"]`, not a second message, new kind or backend feature.
Channel presentation uses a canonical session reference, suppresses prompt media,
and does not earn prompt read dwell. Full thread content remains available.
Missing Sessions/agent evidence falls back to the ordinary readable root; malformed
markers never acquire chip semantics. Quiet creation remains separate and tested.

Command recovery has its own scoped, validated record and editor generation, not
another editor/outbox. Web Locks arbitrate claims; retries reuse retained intent.
Acceptance uses local ID observation, not startup queries. A returned receipt now
updates storage **and** live/React records under the expected-ID lock, preserving
already-accepted state and never recreating a cleared record. Cleanup compares
live and saved input; conflicts retain acceptance and offer explicit recovery/open.
A passive window cannot retire the owner's intent; stale editors cannot create a
replacement. These guarantees are not exactly-once ACP execution.

The sole authorized FOUNDATION source change is `conversation/service.tsx`:
`startCommand`, `registerDraft` and `suspended` are excluded both from Composer's
public type and at runtime after untyped props; the untyped-plugin regression passes.
Existing Share work and deferred session-title/button feedback remain unchanged.

### Checked source and limits

- `bin/pnpm typecheck`, changed-file `biome check --error-on-warnings` (42 files),
  and `git diff --check` pass. No new design-system changes in this round; the
  earlier Share design checks were not repeated.
- `bin/pnpm exec vitest run` on all bundled Sessions files plus command/reference,
  marker/fold, mentions/mentions-live, conversation service/links, timeline sessions,
  composer/DOM/thread presentation/read hook, directories and InlineLink passes:
  **366 tests / 22 files**, **5.24s wall / 15.17s summed execution**; slowest file
  `NewChannelSession.test.tsx`, **3.341s**. Receipt regression fails before the fix
  (zero opens) and passes after: initial lookup held then empty, receipt held until
  acceptance, no subsequent outbox notification, one cleanup/open and no fresh read.
  Late accepted/cleared receipts and explicitly gated competing command claims pass;
  chip read-mask/fallback uses real mounted React, not mocked hook lifecycle.
- `bin/pnpm test:browser tests/browser/channel-sessions.spec.mjs tests/browser/composer-links.spec.mjs --project chromium --project webkit --no-deps`:
  **16 pass**, **28.2s wall / 53.5s summed**; slowest WebKit composer-links **6.9s**.
  One command browser scenario added, none removed: actual rich editor → publication
  → Sessions → chip/thread routing → second command. Failure/race matrices stay in
  Vitest; existing real-window storage cases still pass in both engines.
- `bin/pnpm test:browser channel-opening.spec.mjs --project chromium-measurements --project webkit-measurements --no-deps --workers=1`:
  **2 pass / 6.9s wall**, serial engines. Cold upper bounds **34.8/55ms**; warm
  **38.1–41.9/41–52ms**, no extra warm head read, optional profiles held. Local
  fixture evidence, not a network SLA; timing breakdowns remain in test artifacts.
- Logs: `/tmp/session-command-final-{typecheck,biome,vitest,browser,opening}.log`
  and `/tmp/session-command-receipt-{red,green}.log`. Prior isolated real-relay chip
  proof JSON reports PASS; it does not establish deployed parity, app recovery or ACP.
  Parent final review/enabling, hosted CI, full scan and packaged/native acceptance
  remain pending. Native PID 70281 remains running. No live sends, new dev server,
  native build, commit or push; only isolated browser test harness servers ran.

### Channel `/session` enabled — ready to try (2026-09-22, task 26)

Following user approval and parent authorization after the final independent
source review (task 25), the temporary global `sessionCommandValidation` gate and
its pending-validation error are removed. The task 24 gated checkpoint above is
historical, not the current enablement state. Tests and the browser fixture now
use the default enabled host code, without a mutable opt-in. No permission,
plugin-registration/lifetime, Web Lock, storage, generation or outbox guard was
removed. Missing Sessions still fails closed; mounting/re-enabling does not
publish or automatically replay an intent. No composer props or navigation changed
in this enablement round. Existing Share work and deferred button/long-title
feedback remain unchanged.

**Try:** in an ordinary channel, type `/session `, then **select an exact agent
from the `@` picker**, then enter the prompt and Send. Merely typing a name is not
selection. Acceptance opens the full Session; Channel shows a chip for that same
kind-9 root, not an additional publication. Live command/send/ACP acceptance is
still pending; this round made no live sends.

Checks on the uncommitted tree based on `df04c96` after gate removal:

- Full command (20), directory lease (29), conversation service (16) and
  MessageComposer (57) files: **122 tests / 4 files pass**, **4.87s wall / 7.12s
  summed execution**; slowest file `MessageComposer.test.tsx`, **3.301s**. One
  obsolete gated-command test case was removed (command file 21 → 20); no safety
  cases were removed. The earlier **366-test** checkpoint was not rerun and is
  not a count for this snapshot.
- Full `channel-sessions.spec.mjs` and `composer-links.spec.mjs`, Chromium and
  WebKit: **16 pass**, **28.4s wall / 50.9s summed displayed test durations**;
  slowest cases are the layout journey in each engine, **5.4s**. No browser cases
  were added or removed. These prove fixture-backed rich-editor, publication,
  navigation and real-window behavior, not live runner acceptance.
- `bin/pnpm typecheck`, changed-file Biome (**42 files**, no warnings) and
  `git diff --check` pass. Logs: `/tmp/session-command-enable-{vitest,browser,typecheck,biome}.log`.
- The existing `/tmp/channel-sessions-chip-proof.json` reports **passed** at
  `2026-09-22T13:34:54.897Z`, using old Buzz source `4472da6491f7d76ebcffed4b65c341a3278aa25f`
  and app base `df04c96`. Its actual `buzz-session/1/chip` root proof covers
  authenticated create/invite/admission, teammate-signed exact-event read,
  Postgres content/tags/signature, same-signed retry storing one root, nonmember
  private-channel denial, and durable roundtrip after relay restart/reconnect.
  It used an isolated source-built relay and disposable Postgres/Redis/MinIO;
  it does **not** establish deployed-relay parity, app recovery, ACP reply or
  exactly-once execution. The proof was read, not rerun, during enablement.

Ready to try, not broad/native validation. Hosted CI, broader validation and
packaged/native acceptance remain deferred; no full scan, build, commit, push,
private configuration edit or native restart was performed. Native PID 70281 was
left running. Only isolated browser test harness servers ran.

### `/session` typing feedback — 2026-09-22, task 27

Typing an exact leading `/session` now shows **New session — Select an @agent
and add a prompt.** above the ordinary channel editor. This quiet, wrapping
caption recognizes the command; it does not validate an agent or promise plugin
availability. Existing errors remain separate, and Send retains its fail-closed
checks. The hint disappears for literal `/sessionfoo`, removed commands, locked
submission and non-channel contexts. Static polite status text describes the
input without modifying source, selection or undo; no picker, read, navigation
or publication is triggered by the hint.

Compared rendered light/dark 390/740/1280 screenshots with the existing Figma
composer reference (`/tmp/sessions-figma-draft.png`). The caption is an intentional
functional addition, not a state depicted in that frame; composer insets/actions
and shared tokens remain unchanged, with no extra card. Deferred title/button
polish remains untouched.

On the uncommitted `df04c96`-based tree: **94 tests / 3 complete files** pass
(MessageComposer, command parser and command hook; **4.16s wall / 5.39s summed**,
slowest MessageComposer **3.086s**). The new recognition test failed before the
fix. The complete existing browser file passes **14 cases**, Chromium + WebKit,
**23.8s wall / 42.8s summed displayed durations**; slowest layout case **5.4s**.
No browser cases were added/removed: its existing command journey now checks
native focus/caret, immediate recognition/removal, no automatic publication and
hint geometry/screenshots. TypeScript, changed-file Biome and diff checks pass.
Logs: `/tmp/session-command-hint-{red,vitest,typecheck,biome,browser}.log`.
Screenshots: `/tmp/session-command-hint-browser-artifacts/channel-sessions-channel-s-171fc-ined-editor-can-start-again-{chromium,webkit}/session-command-hint-{390,740,1280}-{light,dark}.png`.

Ready for the running app's HMR feedback; native PID 70281 remains running and its
live draft was not automated or sent. No scan, backend/native build, restart,
commit or push. Live/native acceptance, broad validation and hosted CI remain
separate; fixture screenshots are not live ACP evidence.

### Native feedback checkpoint — 2026-09-22, 10:32

The user reported the `/session` flow and feedback working in the running native
app: “it works!” This is user feedback acceptance, not an independently captured
ACP/text-reply trace or CI validation. Button/title UI polish remains deferred
and unchanged.

### Retained personal sidebar — ready to try (2026-09-22, task 33)

Ordinary channel rows now offer up to five positively known sessions the viewer
started or participated in, followed by **View all sessions**. Participation is
root/reply authorship or a validated relay summary participant, never a received
mention or a read. Agent eligibility uses exact keys from already-loaded profiles
and the local library. Ordering follows the latest retained conversational root
or reply, not a summary timestamp, edit, reaction or telemetry. Edited ordinary
roots keep the existing conservative mention rule; quiet/chip roots preserve
explicit original recipients.

This is intentionally **partial loaded-history evidence**, not an account-wide
index. The sidebar starts no channel window, observer, profile/library read,
subscription route or acknowledgement. Its plugin-owned shared projection uses
the existing retained heads, history, traffic and accepted/seen local evidence.
The store's optional passive API emits compact immutable rows (160-character
excerpts, capped positive identity lists), with strict single-channel partitioning
before overlays and exact relay-author/singleton `h`/`e`/`d` summary validation.
Verified remote proof wins over stale local failure state. Clear/access/disposal
fences are synchronous; passive publication is coalesced after mutations rather
than reentering an unfinished commit. Existing byte/row owners remain the bounds.

The approved optional conversation-sidebar contribution owns presentation only.
Channels owns cross-channel destination intent and revocable root/directory
commands, including exact registration, session/generation, scope, navigation,
access, connection and retained-cache lifetime. Existing private Session children,
drafts and the channel menu's private **New session** remain separate. View all
opens the existing bounded Sessions tab, not a promise of complete history.
No `session.ts`, backend, global navigation target, signer or persistence format
change was made.

Evidence on the uncommitted tree based on `e3bf091`:

- TypeScript and changed-file Biome pass; 295 focused Vitest checks across 23 files
  pass (store/prepared/revocation/live/traffic, Channels, Sessions, command/private
  coexistence and conversation registration). Tests include strict mixed summary
  evidence, cross-channel edits/deletes, remote/local precedence, unmounted local
  roots/hydration, silent head/tail/window eviction, reentrant clear/revoke,
  bounded DTOs, passive source work and stale callback rejection.
- All 14 Chromium/WebKit session browser checks pass. The existing file is
  extended, not multiplied: native keyboard
  collapse/expand, cross-channel root/View all navigation, selected state and
  sidebar focus restoration. Its existing light/dark 390/740/1280/1512px matrix
  also checks child indentation, containment and truncation. Broad selectors were
  scoped to the exact directory after sidebar titles made them ambiguous. A new
  geometry assertion caught insufficient child indentation in both engines; the
  child inset was fixed rather than relaxing the assertion. Final wide/light and
  narrow/dark screenshots were inspected.
- Serial Chromium/WebKit opening checks pass with optional profile work held and
  no new warm head read. Local Apple Silicon warm samples were 40.2–43.8ms and
  40–43ms respectively, under the unchanged 100ms budget. Cold visibility upper
  bounds were 41.3ms/53ms (including Playwright assertion roundtrip). The modeled
  cold head read had 0ms reader queue, 0.03/0.04ms broker admission, 2.98/3.05ms
  upstream, 0.7/1ms verification and 11.5/13ms total fetch; these stages overlap
  the visibility interval and are not additive. This is fixture evidence, not a
  live-network SLA.

Eugene's independent review (task 36) and final synchronous follow-up both
**PASS** for the retained projection's strict boundary, reentrant reset and compact
`byChannel` shape. A separate final synchronous review **PASS** covers exact
cross-channel destination intent. These were read-only source reviews; no tests
were run by the reviewers. The coder's 295 checks / 23 files, 14 browser checks
and two opening checks above remain the test evidence for this snapshot.

The parent inspected the final 1512px light Chromium and 390px dark WebKit
screenshots against the Figma reference. The sidebar retains the maximum of five
sessions and the partial-history note, with no fake badges. The parent also
verified native PID 70281 running and HTTP 200 from the development server; this
is process/server health, not human sidebar acceptance.

No live write, native restart/build, commit, push or full scan was performed.
Human native sidebar feedback, hosted CI and broader integration remain pending.
Title/button polish remains a separate agreed feedback item.

### Sidebar quieting feedback — 2026-09-22, 11:34

Session children now default **collapsed**, including existing private children;
Channels/Starred category disclosure defaults are unchanged. New explicit
expansions are recorded in the existing scoped sidebar view preference, surviving
channel/page navigation and reload. Legacy explicit collapses remain closed;
legacy absence never recorded whether a group had been deliberately expanded, so
that unrecoverable distinction is treated as unknown/closed. This adds no store
migration. Optional expansion state tolerates existing HMR memory. Search expands
matching parents temporarily without changing the choice; private **New session**
still explicitly opens its parent and draft. Traffic and label changes do not
expand groups or change the passive retained-evidence owner.

**View all sessions** remains available whenever the children are expanded, even
with zero known personal sessions. It is now an unfilled, fit-content 14/20
body-small control in normal weight, aligned with child text, without a branch
or selected-row pill. Current/hover/keyboard-focus states use primary text only
(with the focus ring retained), and the native hover title repeats the truthful
loaded-history or unavailable description. The repeated sidebar coverage paragraph is
visually hidden and attached with `aria-describedby`, including the truthful
unsupported-capability description. The directory's visible partial-history copy
is unchanged. No opacity-based text color, global font/button tuning or new icon
was added.

Reference: read-only `block/berd` at
`00ad86965c32297c54abad94669fd7ceb55977e2`, `SidebarProjectList.tsx`
(`expandedProjects[id] ?? false`), `SidebarProjectSection.tsx`
(`PROJECT_CHAT_DISCLOSURE_CLASS`, disclosures below children), and
`disclosure-button.tsx` (ghost/flush/sidebar concept). Buzz uses its own authored
text tokens rather than Berd's opacity recipe. Expanded indentation was compared
with Figma directory frame `1357:15191`; the user's collapsed-default instruction
supersedes that older expanded example.

Evidence on the uncommitted `e3bf091`-based tree: TypeScript, focused Biome,
`design:check` (including contrast), and 43 tests across the complete sidebar-view,
sidebar-row, directory-sidebar, Channels-directory integration and PersonalSessions
files pass (5.13s wall / 3.71s summed test time; slowest file 3.126s). The existing
browser file passes all 14 Chromium/WebKit cases (28.5s wall / 50.5s summed displayed
durations; slowest layout case 7.1s). No browser cases were added or removed: the
existing journey now covers native keyboard/reload/page-navigation behavior, and
its 390/740/1280/1512 light/dark matrix checks collapsed/expanded geometry, unfilled
current/hover states, text alignment and keyboard focus. Reload first exposed the
fixture's regenerated viewer/scope, corrected with fixed synthetic seeds and an
explicit row-count option—not a product storage workaround. The design guard
caught a literal inset, replaced with the equivalent spacing token. Final wide
light and narrow dark screenshots were inspected.

Logs: `/tmp/session-sidebar-polish-{typecheck,biome,vitest,browser,design}.log`.
Screenshots: `/tmp/session-sidebar-polish-browser-artifacts/channel-sessions-fixture-l-c98f8-row-intermediate-wide-views-{chromium,webkit}/sessions-{collapsed-,}{390,740,1280,1512}-{light,dark}.png`.
Ready for HMR feedback and independent parent review, not broad/native acceptance.
No live write, native restart/build, commit, push, store-suite rerun, opening
measurement or full scan; backend/passive data ownership is unchanged. General
button and long-session-title polish remain deferred.

### Personal observed unread — ready to try (2026-09-22, 12:08 relay freeze)

The user's relay/backend freeze defers shared rename: its shared persistence
contract is unresolved; no local-only rename substitutes for it. This increment
adds personal unread dots, not activity or public ownership signals, to the
bounded shared directory (200 roots) and retained sidebar (five per channel).
Existing `unread.snapshot/subscribe` combines positive root-message and reply-only
thread evidence without summing a total. Unknown/zero omit the dot, never claim
all-read; manual device-only intent and observed/stale evidence remain labelled.
No fetch, read acknowledgement, order/date change, auto-expansion or View all
badge is added. Existing full Session visible-message reading remains the owner.
At the preceding task 47 checkpoint on the dirty `e3bf091` feedback tree:
typecheck, targeted Biome, design checks, 259 focused Vitest checks / 20 files
(nine new), and all 14 changed-file browser
checks passed in Chromium/WebKit. The existing layout journey now checks real
unread dots; no browser cases added/removed. Wide/light and narrow/dark screenshots
were inspected. These synthetic checks are not live/native acceptance.

Per the parent report, Eugene's task 49 read-only source review identified one
blocker: irrelevant stale zero/unknown snapshots qualified fresh positive unread
evidence. Task 50 limits the observed stale warning to positive observed
snapshots; manual wording is unchanged and does not claim freshness. Three
separate-root/thread RTL cases cover fresh positive + stale zero/unknown and
stale positive + fresh zero. The first two failed before the fix; the complete
`SessionUnread.test.tsx` now passes all 12 tests, including the existing actual
service/caller checks. Targeted Biome and diff checks pass. The preceding
259-test/browser/design/typecheck checkpoint was not rerun; no new independent
review, visual or native acceptance is claimed for this copy-only correction.
Native PID 70281 was left unchanged. Ready for parent review and HMR feedback.

Activity, shared rename, button/title polish, hosted CI and broader integration
remain deferred. No live write, native restart/build, commit, push or full scan.

### Owner-visible session-row activity — ready to try (2026-09-22)

The 12:08 relay/backend freeze remains: shared rename, broad button/title polish
and inline agent-reply activity timelines are separate, deferred slices.
Rows now passively join existing owner-visible turns to retained same-channel
messages. Only `turn_started.payload.triggeringEventIds` supplies correlation:
all IDs must be lowercase hex, at most 64, and all must resolve to one retained
root within 32 parent steps. Missing, conflicting or multiple-root evidence is
omitted. IDs survive raw-record eviction within the existing 512-turn RAM bound;
conflicting starts invalidate correlation until eviction/reset. Raw frames stay exact.
Working/unknown uses existing freshness; ended turns disappear. Absent is not idle,
process state, ownership proof, an ACP transcript or a late-attachment guarantee.
The existing Agent Activity plugin alone activates capture. Sessions adds no query,
profile lookup, timer, invocation change, read acknowledgement, date/order update,
participation inference or auto-expansion. Neutral status is separate from unread.
On the dirty `e3bf091` feedback tree: typecheck, changed-path Biome, design guards,
211 focused Vitest checks/19 files passed (5.55s wall, 12.06s summed execution);
two additional lifecycle cases then passed with their full four files (45 checks).
The existing browser file passed 14 Chromium/WebKit cases (29.6s wall); no cases
added/removed. Its actual-plugin journey and layout matrix now cover activity,
unread coexistence, focus/order stability and collapsed state; wide/light and
narrow/dark screenshots were inspected. Per the parent report, task 53's independent
read-only source review passed; that review ran no new tests. Live/native/packaged
acceptance and broad gates remain deferred; no restart, live write, commit or push.

Task 54 resolved the earlier WebKit two-window test failure without production
changes. Test-only native-lock tracing reproduced 13 pass / 1 fail: the acceptance
cleanup callback returned true, but the other page still read the saved creation
record and correctly requested recovery. A queued native lock count did not prove
cross-window localStorage visibility. The existing case now keeps real competing
claims in its first phase, then waits for accepted navigation and absent creation
records in **both** pages before submitting the still-mounted, unchanged second
editor. The exact stale-error and single-root assertions remain; no retries,
timeouts, tolerances, error allowlists or browser cases were added/removed. The
existing colocated accepted-cleanup-before-queued-claim and same-text ABA checks
remain in `NewChannelSession.test.tsx` (all 28 checks pass, 4.94s wall / 3.46s
execution). Browser-native contention and cross-page storage remain browser checks.

On the same dirty `e3bf091` feedback tree plus this test-only correction, the full
browser file passed all 14 checks in Chromium/WebKit twice (30.6s and 29.8s wall;
54.9s and 54.5s summed displayed test durations; slowest layout cases 8.4s and
8.6s). Before correction, the instrumented reproduction took 41.2s wall / 64.8s
summed execution, with the failing WebKit case at 13.8s. These are local Apple
Silicon fixture measurements, not hosted CI or proof that all flakes are gone.
Targeted Biome and diff checks pass. Logs/artifacts:
`/tmp/session-activity-staleclaim-*`, including `diagnostic-full.log`,
`lock-evidence.json`, `browser.log`, `confirm.log` and `vitest.log`. Temporary lock
instrumentation was removed; no fixture, production, backend, relay or native
code was changed by this correction. Broader type/design/source evidence remains
the preceding checkpoint, not a new full scan.

### Inline owner activity — ready for review/try (2026-09-22)

The optional directory `threadAccessory` reuses ThreadPanel's loaded canonical
root/replies, after the root and before replies; its isolated failure does not
remove the transcript. Sessions passively joins retained exact agent/turn/channel
correlation. Missing, ambiguous or poisoned evidence is omitted, never rebuilt
from raw trigger payloads. Any post-terminal start poisons correlation, including
identical IDs, until reset/eviction; an ended turn never resumes working.
Batch children require their own explicit scope; nested batches are omitted.
The 100-record / 256-KiB display cap does not mutate the original raw panel.
Details mount escaped plaintext only after disclosure; projected children are
labeled reserialized JSON. Loaded names/key fragments group observations, not
chat attribution. No timestamp ordering, guessed “Thinking”, avatar or fake reply.
The quiet 14px activity Accordion follows the reference hierarchy, deliberately
at turn level because telemetry has no reliable reply-event mapping. Title/button
polish remains deferred, including the existing narrow heading wrap.
No activation, query, profile fetch, clock, signing or backend change is added.
The existing activity plugin owns capture; disable/cache/access resets clear it.
ThreadPanel observes only accessory size and preserves message reading anchors,
including native clamping before ResizeObserver when expanded activity disappears.
On dirty `e3bf091`: typecheck, 21-path Biome and design guards pass; 138 focused
Vitest checks/13 files pass (4.57s wall, 8.39s execution), including the full
22-check host file and its new retarget/lifecycle case (2.99s tests).
The full browser file passes 16 Chromium/WebKit checks (32.7s wall, 58.1s summed,
slowest 8.7s). One case added, none removed: actual animated keyboard disclosure
and native scroll anchoring require browsers. Correlation/nested-batch and scroll
regressions failed before fixes.
Logs: `/tmp/inline-*`; screenshots: `test-results/browser/channel-sessions-inline-*`.

Per the parent report, Eugene's task 63 read-only final source review **PASS**
covers privacy, post-terminal same-ID correlation poisoning and explicit nested
scope handling. The parent's independent final scroll source review **PASS**
covers `ThreadPanel.tsx:389–471`, including layout-effect refs and the `onScroll`
height guard. These were source reviews, not test runs; the preceding 138 focused
checks / 13 files and 16 Chromium/WebKit browser checks remain the test evidence.

The parent inspected the wide/light Chromium and narrow/dark WebKit screenshots.
The existing poor long-title wrap remains observed and user-deferred to the
separate button/title polish pass; it was not fixed in this handoff. The parent
also verified native PID 70281 and HMR, not live/native acceptance. Live/native/
package acceptance, hosted CI and broader integration remain pending. No new test
execution, live protocol write, native restart/build, commit, push or full scan
was performed for this documentation handoff.
