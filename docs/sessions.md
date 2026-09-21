# Channel Sessions: shared thread-backed V1 contract

Status: **product direction agreed; bounded agent-thread Sessions implemented, not full V1**.
Updated 2026-09-21 from the Sessions design discussion. Current-app inspection:
`333c4f287241868d9bb734ac466e98260c0a1824`. Existing Buzz inspection:
`4472da6491f7d76ebcffed4b65c341a3278aa25f`. Neither source inspection nor this
spec establishes deployed relay/runner behavior or live acceptance.

**Approval update, 2026-09-21:** the user approved the first fixture-backed
Channel/Sessions directory and existing full-width thread slice. FOUNDATION
permission is limited to the exact channel-directory contribution in conversation
`contracts.ts` and `service.tsx`. The broader product behavior below is unchanged;
channel-session creation, shared metadata and directory completeness remain
future work, not claims of this preview. The later all-thread preview was incorrect and is withdrawn by the agent-only
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
“Threads that mention or include an agent. Showing loaded history.” Only positive
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
folded rows; edited prose does not inherit the original root's mention classification.
Author/participant evidence remains independent. Later human replies mentioning an
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

Start time is explicitly labelled **Started** and drives provisional ordering/date
groups. This does **not** fulfill or reduce V1's latest-conversational-message ordering
or complete historical eligible-agent-thread coverage. The bounded reply sample is
not a complete transcript; missing historical/nested evidence remains a gap.

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

No session creation/marker write, rename, chip, participation sidebar or activity
correlation is added. The earlier isolated marker feasibility probe is not copied:
there is no production marker caller in this increment. Synthetic events exist
only in source-fixture tests, never the normal app or feedback path.

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
