# Pop-out conversation windows — design proposal

Status: **proposal, not implemented.** Worktree `design/popout-window` at
`origin/main` 92d4c36. Authored by Jaw-fable51-pi for jaw. Revision 2 after
jaw-gpt56sol's adversarial review (findings 1–5 in §5 and §9 accepted; review at
`~/.buzz/RESEARCH/BUZZ_POPOUT_ADVERSARIAL_REVIEW_2026_11_03.md`).

Requests: jaw ([buzz link](buzz://message?channel=ad8a406e-8554-4345-818d-44d824476fdc&id=617ac90f03732fb1026b19d4ac0cbba34ef3a34a953c9cb22feb5e8488a914b3&thread=ee272234fd46a925e151a44998a1d781108b9ac9b00b0c01507408654b9d5069)):
"sometimes I want a new window of a thread or a channel"; miread
([buzz link](buzz://message?channel=73572d23-0e3c-4d67-857f-75fdd6581dd7&id=b495b52662fd5e50d3a9cfa966e5e495bad7d6c06328be9f52f5088d0ac14060)):
"I use this feature so I don't lose a message that I need to respond to."
Prior feasibility note by jaw-gpt56sol: plugin API cannot open a trusted window;
this needs a desktop (Tauri) change.

## 1. The Slack reference

Slack desktop's **Open separate windows** — official help:
<https://slack.com/help/articles/4403608802963-Open-separate-windows-in-Slack>
(fetched 2026-11-03). Documented facts:

| Aspect | Slack behavior (documented) |
| --- | --- |
| Purpose | "multi-task and keep up with a few channels or DMs at once" |
| Targets | Any channel or DM; threads; Activity and To-dos tabs; canvases |
| Channel/DM entry | **Cmd-click (Mac) / Ctrl-click (Win/Linux)** the conversation name in Home |
| Thread entry | Thread pane `⋯` → **Open in new window** |
| Activity/To-dos | Hover preview → window icon, or Cmd/Ctrl-click in sidebar |
| Count | "as many windows as you'd like", drag to arrange |

Not documented by Slack (product-knowledge only, (?) = confirm in a client before
treating as a target): window contents are header + messages + composer without
sidebar/search; reopening the same target focuses the existing window (?);
main and pop-out can both show one conversation; drafts are shared because they
are server-synced; one read state; links inside a pop-out open in main (?);
closing main keeps pop-outs alive; pop-outs are not restored after restart (?).

The *job* behind the feature (both requesters): keep one conversation visible and
answerable while the main window moves elsewhere. Reading, replying and
not-losing-the-message are the core; reactions, editing and nested threads are
secondary.

## 2. Buzz today (evidence at 92d4c36)

- **One multi-window precedent — the Huddle companion.** `src-tauri/src/huddle_window.rs`
  ("A presentation-only companion. Microphone, identity and call ownership stay in
  main."). Main calls `huddle_window_open(view, actions)`; the companion webview
  (`huddle.html`, label `huddle`, capability `src-tauri/capabilities/huddle.json`:
  "no identity, microphone or relay authority") calls `huddle_window_watch` and
  sends `huddle_window_action`. Native validates every projected `View` with size
  caps. The companion already projects a **conversation**: `Discussion { rows ≤200,
  composer, status, writable, sending, has_more }` with actions `send | older |
  retry | retryMessage | discardMessage | thread`, and it mounts the **real
  `MessageComposer`** through a projected `ComposerSession`
  (`src/features/huddle/composer-contract.ts`, `composer-owner.ts` 493 lines,
  `composer-client.ts` 305 lines; `docs/huddles.md` "Conversation panels and
  cards"). Uploads, membership checks, signing and outbox admission stay in main.
- **Main-only native authority.** Relay sockets, signing, identity, read-state
  publication, deep links, notifications, dock and pairing commands check
  `window.label() == "main"` (≈66 references in `src-tauri/src`; e.g.
  `relay.rs:1969`, `deep_links.rs:73,154,166`, `notifications.rs:94,142`,
  `dock.rs:25,44`). Native sockets are per-call and delivered to the calling
  webview (`federated_identity/socket.rs:65`), capped at 16.
- **Main close semantics.** macOS: `CloseRequested` on `main` is prevented and
  the window hidden — "Keep the webview and running agents alive until explicit
  Quit" (`src-tauri/src/lib.rs:1100-1108`). Linux/Windows: main is destroyed;
  `Destroyed` cancels spools/uploads (`lib.rs:1097-1098`).
- **Drafts.** Composer drafts are `localStorage` view-state keyed
  `draft:<channel>[:thread:<root>]` per scope (`src/shared/view-state.ts`).
  `subscribeView` already listens to cross-window `storage` events, and
  `replaceView` is documented as "Foreground comparison, not a cross-window
  transaction or lock." Tauri webviews of one app share the origin's storage, so
  two windows already see one draft.
- **Conversation addressing.** Every conversation (channel, DM, Solo chat,
  thread) is addressable by `buzz://message?channel=<id>&id=<event>[&thread=<root>]`
  / `buzz://channel/<id>` (`docs/deep-links.md`); in-app the Channels tab
  workspace opens them via `open({ channelId, threadId?, messageId? })`
  (`docs/plugin-architecture.md`, `conversation.ui.Tabs`).
- **UI surfaces that would carry the entry point.** Sidebar row context menu
  (`useChannelRowMenu`, `ChannelSidebarRow`, Solo rows via `SoloDestination`
  `ContextMenuRoot`), channel header *Channel actions* menu (`ChannelHeaderMenu`),
  conversation tab strip menu (`PageTabs` tabMenu: Close / Close other / Close
  all), thread pane header actions (`ThreadPanel` `parent` → "Open in channel"),
  message action bar (`MessageActionBar`: Copy link …).
- **Governance.** `AGENTS.md`: scope checkpoint before code; one implementation
  owner; 9/10 minimalness; FOUNDATION files need explicit human guidance;
  cross-host changes name the host actually validated ("frontend checks do not
  replace host signing or IPC enforcement"); new addressable surfaces follow
  `docs/navigation-history.md`; update `docs/buzz-help.md`; PR readiness = agent
  review → agent exercised in the **native app** → human tested →
  `buzz-review-completed`; DCO sign-off on every commit.

## 3. What parity means in Buzz

**Targets.** Any conversation the viewer can already open in a Channels tab:
team channel, DM, Solo chat, and a thread of any of those. Not pages (Inbox,
Agents, Workflows), not Settings, not Canvas (separate request if wanted).

**Entry points (parity = present wherever the conversation is named).**

| Surface | Item | Notes |
| --- | --- | --- |
| Sidebar row right-click / `…` menu (channel, DM, Solo chat) | **Open in new window** | Same menu that holds Copy link / Mark read. Also **Cmd/Ctrl-click** the row, matching Slack's documented gesture (S2) |
| Conversation header *Channel actions* menu | **Open in new window** | |
| Conversation tab strip tab menu | **Open in new window** | Pops the tab's conversation or thread out; **the source tab stays open** (§5.1, §5.7) |
| Thread pane header | **Open in new window** icon (external-link glyph) next to the existing "Open in channel" | The primary thread path — the requesters' case |
| Message action bar / message `…` menu | **Open thread in new window** | Only on messages with a thread or as a reply target |
| macOS *Window* menu | one row per open pop-out | Free with Tauri window titles |
| Keyboard | none in S1; candidate `⌘⇧O` later | Avoid colliding with existing tab shortcuts (`⌘W`, `⌘⇧W`, `Ctrl+Tab`, `close_menu.rs`) |

"Always in the contextual menu?" — Yes for conversation rows and tabs, since
that is where Slack users look first and it is cheap. On message rows it should
appear only when a thread exists, to keep the action bar from growing.

**Pop-out window contents.** Title = conversation name (thread: "Thread —
#channel"). Header: name, member avatars count, *Open in main window* button.
Body: message list (same shared message renderer and bylines as main). Footer:
the full composer (rich text, attachments, mentions, emoji, GIF — as the Huddle
thread already has). Light/dark follows main (Huddle projects `dark`). No
sidebar, no page nav, no search, no Settings.

**Behaviors.**

1. Many pop-outs at once, one per distinct target. Opening an already-open
   target focuses its window.
2. Main and pop-out may both show the target. Both live-update. One persisted
   draft per target, shared, governed by the composer's **existing conflict
   contract** (§5.1). Attachment drafts stay with the window that added them.
3. Reading in the pop-out earns unread marks through main's reading owner with
   the same geometry/focus/dwell rules as a Channels tab (§5.6). Opening a
   pop-out never marks anything read by itself.
4. Links to other conversations clicked inside a pop-out open in **main** and
   focus it (`openLink` is forwarded as an action). `https` links open in the OS
   browser (Huddle already has `opener:allow-open-url`).
5. *Open in main window* shows/focuses main and opens the target as a main tab;
   **the pop-out stays open** (no move semantics in S1; see §5.2).
6. Closing main (macOS hide): pop-outs keep working because the owner renderer is
   alive. Linux/Windows: closing main closes all pop-outs after flushing drafts
   (S1); keeping them open there would require hide-on-close parity for main,
   which is a separate product decision.
7. Community switch, sign-out, relay session replacement, losing membership or
   channel archive: pop-outs for that scope close with a toast in main (same as
   Huddle: "Disabling the plugin, losing channel access, replacing the relay
   session, or switching community ends the local call").
8. Window size/position remembered per target class (thread vs conversation);
   pop-outs are not restored after restart in S1.
9. Browser build and mobile: no pop-out (no window API); the menu item is absent,
   not disabled.

## 4. Architecture options

### A. Second full renderer (`index.html?window=popout&…`) with main capabilities

Load the whole app in another webview, routed to one conversation.

- Pro: every feature works on day one; smallest UI diff.
- Con: a **second `RelaySession`** per window → second socket and subscriptions
  per pop-out (16-socket native cap), two read-state publishers, two outboxes on
  shared storage, duplicated notifications/unread logic, Huddle/pairing/deep-link
  code that assumes a single `main`. Requires opening signing/identity commands
  to additional labels — expands the trusted surface the Huddle design
  deliberately kept to one window. Reviewers will (rightly) challenge the
  duplicated session semantics; this is the option most likely to be rejected
  under the "clear ownership / no known material defects" bar.

### B. Presentation companion (generalize the Huddle discussion)

Main stays the only session, signer, outbox and read-state owner. A pop-out is a
`popout-<uuid>` webview that watches a projected `ConversationView` and sends
actions back, exactly like the Huddle companion, with the Huddle `Discussion`
projection generalized from "a room's thread" to "any conversation target".

- Pro: reuses ~1.9k lines of existing, reviewed projection code (composer
  contract/owner/client, `discussion.ts`, `window.ts`, native validation,
  `HuddleDiscussionView`); keeps the repo's security model unchanged; nothing new
  gets signing authority; drafts and unread stay single-owner; main-close and
  scope-change behavior inherit the Huddle lifecycle rules.
- Con: fidelity is bounded by what is projected. The Huddle row model has
  text/attachments/mentions/edited/delivery but **no reactions, no thread
  summaries, no message actions, no link previews/cards, no edit/delete**. Each
  added feature is IPC surface plus native validation. Drift risk as main gains
  features.

### C. Thin renderer over a proxied session

Run the real `ThreadPanel` / `ConversationTab` in the companion against a
`RelaySession` proxy: snapshot replication + forwarded operations for the
sub-services the conversation uses (the composer projection generalized to the
read side).

- Pro: full UI fidelity by reusing components; single owner preserved.
- Con: `RelaySession` is a frozen object of ~50 sub-services
  (`src/features/relay/session.ts:2153`); conversation components also call
  native commands directly (media, clipboard, downloads) that are main-gated;
  `useSyncExternalStore` consumers need synchronous replicated snapshots. This is
  a new shared contract of real size — the kind of "speculative abstraction /
  shared contract expansion" `AGENTS.md` asks to justify against a current
  requirement. Reasonable **later**, if B's fidelity gap turns out to matter.

### Recommendation: **B, sliced; keep C as the documented upgrade path.**

B is the only option that is both consistent with the established
companion-window security model and small enough to pass the scope checkpoint.
It directly satisfies the stated jobs (watch, reply, don't lose the message).
Explicitly record the fidelity gap and the trigger for moving to C.

## 5. Decisions on the reviewer's pre-stated criteria

### 5.1 Same conversation open twice; who owns the draft

One persisted draft per target, owned by **storage**, not a window. The composer
already implements the cross-editor contract and the pop-out runs the real
`MessageComposer`, so it inherits it unchanged: an external revision arriving
while the editor is dirty or a send is in flight sets **conflict**; local edits
are retained, sending is blocked until the user resolves (keep mine / load
theirs); an external revision arriving while clean is loaded
(`src/features/messages/MessageComposer.tsx:1247-1261`). `replaceView` is a
foreground comparison, not a lock — the conflict state is what makes that safe.
(Revision 1 proposed last-writer-wins and focus-based reload; withdrawn — it
contradicted the implementation.) Send clears the persisted draft from main only
if the stored revision still equals the one the sender saw
(`composer-owner.ts:280-287` pattern). **Open in new window leaves the source
tab open** (Slack semantics; also avoids §5.7). S1 tests: two editors typing on
one thread draft → conflict in the dirty one; send from A while B has a newer
unsaved draft → B keeps its text, A's stored-draft clear is skipped.

### 5.2 Open in main window must not lose work

Attachment drafts are local to the window that added them and Huddle releases
them on close; conflicted or storage-failed text can exist only in one editor.
So S1 has **no move**: *Open in main window* = show+focus main, open the target
tab, leave the pop-out as is. **Explicit close** of a pop-out (red button,
Cmd+W) runs the same guards as closing a tab, for all of: pending attachment
drafts, an unresolved draft conflict, text whose last persist **failed**
(`writeView` returned false), and pending operations in that window (send
awaiting admission, upload in progress) → confirm dialog naming what would be
lost. **Voluntary** exits that would retire pop-outs — community switch,
sign-out, Linux/Windows main Close — run the same guards first and can be
cancelled; a toast after the fact is not a guard. **Access revocation**
(membership loss, archive, relay session replaced by the server, plugin
disabled) retires immediately without prompting, because unauthorized context
must leave the screen; main toasts what closed. A later "move" variant needs an
acknowledged handoff that keeps the source until the destination exists.

### 5.3 Which window owns signing / session actions; binding

**Main, only.** Pop-outs get a capability modeled on `huddle.json`: `watch`,
`action`, `media-download` (restricted to sources in **that window's** current
projection — `media_download` today keys the check on the single `huddle`
label; it becomes per-label), `clipboard-write-text`, `opener:allow-open-url`.
No `relay-*`, `identity-*`, `sign-*`. Each window is bound at open to
`{ scope, viewer, channelId, threadRootId, sessionIncarnation }`; native stores
the binding with the session and rejects `watch`/`action`/`download` whose
caller label or binding doesn't match. Every action is re-validated in main
against current membership/writability before it reaches the outbox, as the
composer owner does today. Tests: two roots in one channel do not cross; an
action carrying a retired incarnation is dropped, not replayed.

### 5.4 Huddle's "thread" is a room stream — S1 needs real thread semantics

`HuddleDiscussion` streams a room's top-level messages: its composer has
`messages.reply: unavailable` (`composer-client.ts:246`), sends with top-level
`messages.send` and clears `draft:<room>` (`composer-owner.ts:271-287`). A thread
pop-out instead needs: verified-root loading (the `ThreadPanel`/`useMessageOpening`
reader rules — cached rows decide nothing), `messages.reply` to the root, the
thread draft key `draft:<channel>:thread:<root>`, and admission bound to the
target (§5.3). So S1 reuses the **composer projection** (contract/owner/client)
and the window/validation plumbing, but the **read projection is new**: a
`ThreadView` produced from the existing thread reader, not `discussion.ts`. This
is the main reason the S1 estimate rose (§5.8).

### 5.5 Main window closes

- macOS: hidden, renderer alive → pop-outs keep working. Add: a pop-out's
  *Open in main window* must `show()`+focus main (hidden main is the common case).
- Linux/Windows: destroying main destroys the owner. S1: on `CloseRequested` of
  main with pop-outs open, run the §5.2 guards across them (a persist can have
  failed; not every keystroke is necessarily in storage), then close pop-outs
  first; cancelling keeps main open. Alternative (hide main on close, as macOS) is a separate
  product decision; listed in §8.
- Renderer reload/crash of main: native keeps the last validated projection per
  pop-out and bumps `sessionIncarnation`. The companion shows the cached
  messages read-only with a "Buzz is reconnecting…" notice, its composer is
  disabled, and any action carrying the old incarnation is rejected — **no send
  replay**. On main startup S1 **retires** surviving pop-outs with an in-window
  "Reopen from Buzz" notice (persisted drafts are already in storage); re-adopting
  them is an S2/S3 item. (Huddle's `reset_incoming` only covers
  incoming/connecting calls, so this is new, small native state — not inherited.)
- **Cmd+W**: `close_menu.rs` routes Close Tab to the focused *main* webview only.
  With a pop-out focused, Cmd+W must close that pop-out (through §5.2 guards);
  Cmd+Shift+W stays main-only. Linux/Windows have no app menu equivalent;
  the window's own close control applies.

### 5.6 Reading and unread parity

Unread is earned, never granted: `docs/unread.md` requires a focused active
reading surface, visible document, settled positioning, fully visible rows and
300 ms dwell, with cancel/restart on scroll/content/focus change and manual
unread respected during dwell. The Huddle bridge has no reading path. S1 adds
one: the companion runs the same reading-observer module over its own geometry
and focus (window focused, `document.visibilityState`, rows fully visible, dwell)
and sends `observe(ids)` actions; main validates that the ids are in that
window's projection and feeds them to the session's reading owner, which holds
the lease. Main hidden (macOS) does not block it; a minimized/backgrounded
companion observes nothing; manual *Mark unread* in main during dwell wins.
Opening a pop-out marks nothing. Observations carry the companion's focus/
visibility generation and the incarnation; main drops an `observe` whose
generation predates a blur, hide, or a newer manual *Mark unread* — **delayed IPC
must not resurrect cancelled reading intent**. Acceptance includes that case.
Shipping without this path (**S1a**) is a product tradeoff — unread stays lit
for messages read in a pop-out — for jaw to accept explicitly, not a
line-budget shortcut.

### 5.7 Navigation history

A pop-out is a native window, not an addressable dialog or tab, so it creates no
history visit. Because the source tab stays open (§5.1) no existing content
history changes; *Open in main window* opens an ordinary tab visit. Failed
opens (window creation error) leave the source exactly as it was and toast in
main.

### 5.8 Community or scope changes

Projection carries `scope`. Voluntary switches (community, sign-out) run the
§5.2 guards and may be cancelled; revocations (relay-session replacement,
membership loss, channel archive) retire the affected pop-outs immediately
(`update(id, null)` → native `destroy()`) with one toast in main naming what
closed. Huddle's rule set plus the voluntary/revoked distinction.

### 5.9 Initial slice vs full parity

| Slice | Content | Approx. production diff (excl. tests/docs) |
| --- | --- | --- |
| **S1 — Thread pop-out** | Entry points: thread pane header, tab menu, message `…` (when a thread exists). Native: `popout_window_open/update/watch/action` generalized from Huddle with `HashMap<label, Session>`, per-window binding + incarnation (§5.3), per-label download gate, Cmd+W routing. Renderer: `popout.html` entry; new `ThreadView` read projection from the thread reader (§5.4); composer projection reused with `reply` + thread draft key; `HuddleDiscussionView`/`HuddleComposer` moved to a shared owner; reading observations (§5.6, or S1b). Actions: send/older/retry/discard/openLink/openInMain/observe/closed. Focus-existing on reopen. Close guards (§5.2). | ~1,300–1,800 lines (native 400–550, thread projection + owner 400–600, composer generalization 150–250, UI 250–300, menus/shortcut 100) — above the 1k mark; split S1a (window+read-only+composer) / S1b (reading) if review asks |
| **S2 — Channel / DM / Solo chat pop-out** | Same window, target without thread root: top-level stream, day dividers, "Reply in thread" action that opens the thread in **main** (or in another pop-out), typing indicator, members count. Sidebar row and header menu entry points. | ~400–700 |
| **S3 — Fidelity** | Reactions (read + add), edit/delete own messages, link previews/cards, read-marker. Each as its own small PR; at this point evaluate Option C instead of adding more projection fields. | per item 150–400 |

Non-goals for S1–S2: canvases, pages, Settings, restoring pop-outs after
restart, browser/mobile hosts, Linux/Windows hide-on-close, keyboard shortcut.

### 5.10 Validation

- Native: wire encoding/validation tests beside the Huddle ones
  (`huddle_window.rs` tests); label-gating tests for the new capability.
- Renderer: Vitest for the projection reducer and menu items; browser journey
  only for what lower layers cannot prove (none expected for S1; the companion is
  a native window).
- **Native app checks are mandatory**: open → type → send → close; reopen focuses;
  main hidden on macOS then *Open in main window*; community switch retires;
  dark/light, narrow width, enlarged text; keyboard focus order in the pop-out.
  Browser screenshots do not validate window lifecycle or IPC gating.

## 6. Getting it merged (per `AGENTS.md` / `docs/contributing.md`)

1. **Justification on record.** This doc plus the two user requests; the Huddle
   precedent shows the pattern is already accepted. Frame S1 as "generalize the
   existing companion to conversation threads", not "add multi-window".
2. **Scope checkpoint before code** (publish in the PR/issue): required behavior
   (§3 S1 rows), non-goals (§5.9), owners reused (`huddle_window.rs`,
   `composer-owner/client`, `discussion.ts`, `HuddleDiscussionView`,
   `ContextMenu`/`MenuItem`, `PageTabs` tabMenu, `ThreadPanel` header), expected
   files, diff budget (§5.9).
3. **FOUNDATION check.** None of the files named in §5.5 carry a `FOUNDATION`
   marker at 92d4c36 (`huddle_window.rs`, `lib.rs`, `capabilities/*`,
   `features/huddle/*`, `bundled/huddles/*`, `ThreadPanel.tsx`, `PageTabs.tsx`);
   15 files in the repo do — re-grep when the file list is final.
4. **Design-system rules.** Reuse `MenuItem`, `Button`, `Panel` recipes; name the
   DESIGN.md sections in the checkpoint; check both themes, narrow width,
   enlarged text, keyboard/pointer.
5. **Navigation contract.** A pop-out is a native window, not an addressable
   dialog/tab, so it creates no history visit; *Open in main window* opens a
   normal tab visit. State this in the PR so reviewers don't expect history
   coverage.
6. **Cross-host statement.** Desktop-only; browser build hides the entry points;
   validation host = macOS native app (name the OS/arch actually used).
7. **Docs.** `docs/buzz-help.md` (user-facing), `docs/huddles.md` cross-reference
   if the discussion projection moves to a shared owner, this doc updated from
   proposal to implemented behavior.
8. **PR flow.** Draft PR → agent review (necessity + correctness, 9/10 bar) →
   agent exercises in the native app → jaw tests with exact steps → add
   `buzz-review-completed`. Every commit `--signoff`; Co-authored-by trailer for
   the agent.
9. **Reviewer pre-reads** (`AGENTS.md` Reviewing): block/buzz `VISION*.md`
   for the conversation surface, `docs/huddles.md`, `docs/shell-design.md`,
   `docs/navigation-history.md`.

## 7. Risks

- **Scope.** S1 is now ~1.3–1.8k production lines; the honest comparison is "a
  second Huddle-sized feature", not a menu item. Mitigation: S1a/S1b split; ship
  read-only+compose first.

- **Fidelity expectation.** Users may expect reactions/threads in the pop-out
  immediately. Mitigation: S1 header shows *Open in main window* prominently;
  release note names what the pop-out does and does not do.
- **Projection drift.** Mitigation: one shared owner module for the row DTO used
  by both Huddle and pop-outs so a renderer change updates both.
- **Linux/Windows main-close.** Pop-outs close with main; acceptable for S1 but
  weaker than Slack.
- **Tauri capability globbing** for `popout-*` labels: confirmed supported in the
  pinned tauri 2.12.4 / tauri-utils 2.9.3 (`acl/capability.rs:150,164`, "Can be a
  glob pattern").

## 8. Open questions for jaw

1. Slack details marked (?) in §1 — confirm from your client: focus-existing on
   reopen; links inside a pop-out open in main; pop-outs not restored on restart.
2. Reviewer-settled: Open in new window keeps the source tab; Open in main keeps
   the pop-out. Any objection?
3. Linux/Windows: accept "closing main closes pop-outs" for S1?
4. Is S1 = threads only acceptable as the first PR, with channels/DMs/Solo in
   S2? If S1 runs long, do you accept **S1a** — pop-outs that read and reply but
   do **not** clear unread (unread stays lit for messages you read there) —
   as an interim product state, with S1b following?
5. Does this belong in `block/buzz-app` core (recommended; needs native) or
   should the entry points also be exposed to plugins later (`ctx.windows.open`)?
   Core first; plugin API only on demand.
6. Window title/branding for pop-outs ("Thread — #channel — Buzz"?), and
   whether the pop-out should show the member avatar stack or only the name.

## 9. Review log

- 2026-11-03 jaw-gpt56sol adversarial review at `dae45a5` (7/10 readiness).
  Findings accepted and folded in: (1) draft policy → existing conflict contract
  (§5.1); (2) Open in main as focus-not-move, close guards (§5.2); (3) Huddle
  thread is a room stream → new thread read projection, binding and incarnation
  (§5.3–5.4); (4) unread parity via main-owned reading leases (§5.6); (5) history
  untouched by keeping the source tab open (§5.7). Evidence corrections: Slack
  official help cited (§1); `reset_incoming` not generalizable, reload recovery
  specified; Cmd+W routing (§5.5). Estimate raised accordingly (§5.9).
- 2026-11-03 second pass at `4cf951e`: 1, 3, 5 addressed; 4 stated. Finding 2
  extended: close guards also cover storage-failed text and pending operations;
  voluntary switch/close is cancellable, revocation is immediate (§5.2, §5.5,
  §5.8); delayed-IPC reading observations must not revive cancelled intent
  (§5.6); S1a framed as an explicit product tradeoff (§8 Q2/Q4).

## 10. S1 scope checkpoint (per `AGENTS.md` "Engineering standard")

Approved by jaw 2026-11-04 (design, parity, approach B, slicing, core-only,
platform-natural main-close). Implementation owner: jaw (accountable human
author); Jaw-fable51-pi implements and commits as jaw's git identity with a
`Co-authored-by` trailer. Reviewers per CODEOWNERS: `@block/buzz-oss-team`.

### Required behavior (S1 — thread pop-out, desktop only)

1. **Open in new window** for a thread from: thread pane header action
   (beside the existing `parent` "Open in channel" link), conversation tab-strip
   tab menu for thread tabs, message `⋯` on messages that have a thread.
   Source tab/pane stays open. Browser build and non-desktop hosts hide the item.
2. A `popout-<uuid>` native window titled from the thread's channel, showing
   header (title, *Open in main window*), the thread rows (root + replies, same
   shared message renderer/bylines/attachments/mentions as Huddle discussion)
   with *Older* paging, and the real `MessageComposer` replying to the root.
3. Opening an already-open target focuses its window instead of creating one.
4. Main stays the only relay session, signer, outbox and read-state owner. The
   window is natively bound to `{scope, viewer, channelId, threadRootId,
   sessionIncarnation}`; `watch`/`action`/`media-download` are gated per label
   and binding; stale-incarnation actions are dropped, never replayed.
5. Drafts: thread draft key `draft:<channel>:thread:<root>`, shared with main
   through the composer's existing conflict contract; send clears the stored
   draft only on revision equality.
6. *Open in main window*: show+focus main, open the thread tab there, pop-out
   stays. Explicit close (red button, Cmd+W when the pop-out is focused) guards
   pending attachment drafts, unresolved conflict, storage-failed text, pending
   send/upload with a confirm dialog.
7. Lifecycle: voluntary community switch / sign-out / Linux-Windows main Close
   run the guards and are cancellable; revocation (membership loss, archive,
   server-replaced session, Huddle-style plugin disable) retires immediately
   with a main toast. macOS main close hides main; pop-outs keep working. Main
   renderer reload: companion goes read-only, composer disabled, retire on main
   startup with "Reopen from Buzz".
8. Reading (S1b, same PR unless it must split): companion sends `observe(ids)`
   with focus/visibility generation under `docs/unread.md` rules; main validates
   against the window's projection and feeds its reading owner; delayed or
   pre-blur observations are dropped; opening marks nothing. If split, S1a ships
   with "pop-out does not clear unread" stated in `buzz-help.md` as an interim
   product state (accepted by jaw 2026-11-04).
9. Links: Buzz links → `openLink` action, handled in main (focus main);
   `http(s)` → OS browser via `opener`.
10. Light/dark follow main; keyboard focus order and enlarged text checked.

### Non-goals (S1)

Channels/DMs/Solo pop-outs and Cmd/Ctrl-click (S2); reactions, edit/delete,
link previews/cards, read marker in the pop-out (S3); restoring pop-outs after
restart; re-adopting pop-outs after main reload; Linux/Windows hide-on-close for
main; keyboard shortcut to pop out; plugin API (`ctx.windows.*`); canvases,
pages, Settings; mobile/browser hosts; window title/avatar polish (discuss
after first native tryout, per jaw).

### Existing owners and platform support reused

- Native companion plumbing and validation: `src-tauri/src/huddle_window.rs`
  (`open/update/watch/action`, `closed_notice`, size-capped `validate`),
  `src-tauri/capabilities/huddle.json` as the capability template,
  `media_download` label gate (`relay.rs:1958-1975`), `close_menu.rs` for Cmd+W,
  `lib.rs` main-close handling (`:1096-1108`).
- Composer projection: `src/features/huddle/composer-contract.ts`,
  `composer-owner.ts`, `composer-client.ts` (add `reply`, thread draft key).
- Thread reading: `session.thread(channelId, rootId, …)`
  (`src/features/relay/session.ts:2483`), `ThreadPanel` `parent`/`headerActions`
  (`ThreadPanel.tsx:81-152`), `useMessageOpening` verified-root rules.
- Reading: `src/features/messages/use-reading.ts` (`useReading`,
  `readingPositioned`) and `docs/unread.md` contract.
- Window bridge and companion entry: `src/features/huddle/window.ts`,
  `src/bundled/huddles/window-entry.tsx`, `HuddleDiscussionView.tsx`,
  `HuddleComposer.tsx`, `huddle.html` + Vite input as the template for
  `popout.html`.
- Menus: `MenuItem`/`ContextMenu*` recipes; `PageTabs` `tabMenu`;
  `MessageActionBar`. Design guide sections: menus/popovers (nested surfaces),
  dialog (close-guard confirm), buttons.
- Drafts: `src/shared/view-state.ts` (`replaceView`, `subscribeView`).

### Expected files

New: `popout.html`, `src/bundled/popout/*` or `src/features/popout/*`
(window bridge, `ThreadView` projection, companion entry/view, tests),
`src-tauri/src/popout_window.rs` (+ tests), `src-tauri/capabilities/popout.json`.
Modified: `src-tauri/src/lib.rs` (register commands, close handling),
`src-tauri/src/relay.rs` (`media_download` gate), `src-tauri/src/close_menu.rs`,
`vite.config.ts` (second HTML input, as `huddle.html`), `src/features/huddle/composer-*.ts`
(generalize room → target; keep Huddle behavior), `ThreadPanel.tsx`
(header action), `PageTabs.tsx`/`ConversationTab.tsx` (tab menu item),
`MessageActionBar.tsx`, `docs/buzz-help.md`, `docs/huddles.md` cross-ref, this doc.

### Diff budget (production, excluding tests/docs)

| Area | Lines |
| --- | --- |
| Native (`popout_window.rs`, capability, gates, Cmd+W, close handling) | 400–550 |
| `ThreadView` projection + owner (verified root, paging, retire/incarnation) | 400–600 |
| Composer projection generalization (`reply`, thread draft key, binding) | 150–250 |
| Companion UI (entry, view, header, guards) | 250–300 |
| Entry points (3 menus/actions) | ~100 |
| Reading bridge (S1b) | 150–250 |
| **Total** | **1,450–2,050** (≈1,300–1,800 without S1b) |

Stop-and-show rule: if production diff exceeds the upper bound or a new shared
contract beyond the ones listed becomes necessary, stop and post the smallest
alternative before continuing.

### Validation plan

- Vitest: projection reducer, binding/incarnation rejection, draft-key
  derivation, menu item presence by host; RTL for companion view and guards.
- Native Rust tests: DTO validation caps, label/binding gating, per-label
  download gate, two roots one channel, stale incarnation dropped.
- Native app (macOS, name the arch/OS build in the PR): open → type → send →
  close; focus-existing; two editors conflict; Open in main with main hidden;
  community switch cancel/confirm; membership revocation retire; main reload
  read-only; Cmd+W in pop-out; dark/light, narrow, enlarged text, keyboard.
- Not claimed: Linux/Windows native runs unless executed; browser journeys add
  nothing here and are not planned.
