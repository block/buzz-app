# Pop-out conversation windows — design proposal

Status: **proposal, not implemented.** Worktree `design/popout-window` at
`origin/main` 92d4c36. Authored by Jaw-fable51-pi for jaw; adversarial review by
jaw-gpt56sol requested before any implementation checkpoint.

Requests: jaw ([buzz link](buzz://message?channel=ad8a406e-8554-4345-818d-44d824476fdc&id=617ac90f03732fb1026b19d4ac0cbba34ef3a34a953c9cb22feb5e8488a914b3&thread=ee272234fd46a925e151a44998a1d781108b9ac9b00b0c01507408654b9d5069)):
"sometimes I want a new window of a thread or a channel"; miread
([buzz link](buzz://message?channel=73572d23-0e3c-4d67-857f-75fdd6581dd7&id=b495b52662fd5e50d3a9cfa966e5e495bad7d6c06328be9f52f5088d0ac14060)):
"I use this feature so I don't lose a message that I need to respond to."
Prior feasibility note by jaw-gpt56sol: plugin API cannot open a trusted window;
this needs a desktop (Tauri) change.

## 1. The Slack reference

Slack desktop's **Open in new window** (shipped 2023). From product knowledge;
the Slack Help Center could not be fetched from this environment (bot challenge),
so items marked (?) should be confirmed in a Slack client before being treated
as parity targets.

| Aspect | Slack behavior |
| --- | --- |
| Targets | Channels, DMs/group DMs, threads, canvases, huddles |
| Entry points | Right-click a sidebar conversation → *Open in new window*; conversation-name header menu → *Open in new window*; thread pane `⋯` → *Open in new window* |
| Window contents | Conversation header (name, basic actions), message list, full composer. No sidebar, no global search/nav |
| Count | Many pop-outs at once; macOS *Window* menu lists them |
| Same target twice | Reopening focuses the existing pop-out rather than making a second (?) |
| Main + pop-out both showing the same conversation | Allowed; both live, both update |
| Drafts | Shared — Slack drafts are server-synced, so main and pop-out show the same draft |
| Read state | One account state; reading in the pop-out clears unread in main |
| Links clicked inside a pop-out | Other conversations open in the **main** window (?) |
| Closing main | App keeps running (tray/dock); pop-outs keep working |
| Persistence | Pop-outs are not restored after app restart (?) |
| Keyboard | No dedicated shortcut; menu-driven |

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
| Sidebar row right-click / `…` menu (channel, DM, Solo chat) | **Open in new window** | Same menu that holds Copy link / Mark read |
| Conversation header *Channel actions* menu | **Open in new window** | |
| Conversation tab strip tab menu | **Open in new window** | Pops the tab's conversation or thread out; the tab closes (see §5.1) |
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
   draft per target, shared (last writer wins; the other composer refreshes on
   `storage` — already the contract). Attachment drafts stay with the window that
   added them (as Huddle: "closing the panel releases its local files").
3. Reading in the pop-out counts as a visit for unread, exactly as a Channels
   tab does (one read-state owner: main).
4. Links to other conversations clicked inside a pop-out open in **main** and
   focus it (`openLink` is forwarded as an action). `https` links open in the OS
   browser (Huddle already has `opener:allow-open-url`).
5. *Open in main window* closes the pop-out and opens the target as a main tab,
   keeping the draft.
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
already uses `replaceView` with revision comparison and `subscribeView` listens
to other windows' writes. Policy: last writer wins; a composer that receives a
`storage` change while **not focused** reloads the draft; a focused composer
keeps its in-progress text and the next keystroke writes it (today's single-window
behavior unchanged). Send clears the persisted draft from main
(Huddle: "An admitted message clears its persisted draft in the main app even if
the companion closes before acknowledgment"). To keep the first slice simple,
**popping a tab out closes that tab in main** (Slack does not do this; it avoids
the two-live-composers case most of the time while still allowing the user to
reopen the conversation in main). Reopen-in-main is one click.

### 5.2 Which window owns signing / session actions

**Main, only.** Pop-outs get a capability modeled on `huddle.json`: `watch`,
`action`, `media-download` (restricted to sources in its current projection, as
`media_download` already does for `huddle`), `clipboard-write-text`,
`opener:allow-open-url`. No `relay-*`, `identity-*`, `sign-*`. Every action is
re-validated in main against current membership/writability before it reaches
the outbox, as the composer owner does today.

### 5.3 Main window closes

- macOS: hidden, renderer alive → pop-outs keep working. Add: a pop-out's
  *Open in main window* must `show()`+focus main (hidden main is the common case).
- Linux/Windows: destroying main destroys the owner. S1: on `CloseRequested` of
  main with pop-outs open, close pop-outs first (drafts are already persisted on
  each change). Alternative (hide main on close, as macOS) is a separate
  product decision; listed in §8.
- Renderer reload/crash of main: native holds the last validated projection per
  pop-out (Huddle `watch` re-sends the cached presentation); on main reload the
  renderer re-registers owners for live pop-outs or retires them with an
  in-window "Reopen from Buzz" notice (Huddle's `reset_incoming` pattern).

### 5.4 Community or scope changes

Projection carries `scope`. Switching community, sign-out, relay-session
replacement, membership loss, channel archive → main retires the pop-outs of the
affected scope (`update(id, null)` → native `destroy()`), with one toast in main
naming what closed. Identical to the Huddle rule set.

### 5.5 Initial slice vs full parity

| Slice | Content | Approx. production diff (excl. tests/docs) |
| --- | --- | --- |
| **S1 — Thread pop-out** | Entry points: thread pane header, tab menu, message `…` (when a thread exists). Native: `popout_window_open/update/watch/action` generalized from Huddle with a `HashMap<label, Session>`; capability `popout.json` with glob label. Renderer: `popout.html` entry; `ConversationView` = Huddle `Discussion` + `scope`, `title`, `target {channelId, threadRootId}`; reuse `HuddleDiscussionView`/`HuddleComposer` moved to a shared owner. Actions: send/older/retry/discard/openLink/openInMain/closed. Focus-existing on reopen. Lifecycle rules §5.3–5.4. | ~900–1,300 lines (native 300–400, projection generalization 300–500, UI 200–300, menu items 50–100) |
| **S2 — Channel / DM / Solo chat pop-out** | Same window, target without thread root: top-level stream, day dividers, "Reply in thread" action that opens the thread in **main** (or in another pop-out), typing indicator, members count. Sidebar row and header menu entry points. | ~400–700 |
| **S3 — Fidelity** | Reactions (read + add), edit/delete own messages, link previews/cards, read-marker. Each as its own small PR; at this point evaluate Option C instead of adding more projection fields. | per item 150–400 |

Non-goals for S1–S2: canvases, pages, Settings, restoring pop-outs after
restart, browser/mobile hosts, Linux/Windows hide-on-close, keyboard shortcut.

### 5.6 Validation

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
   (§3 S1 rows), non-goals (§5.5), owners reused (`huddle_window.rs`,
   `composer-owner/client`, `discussion.ts`, `HuddleDiscussionView`,
   `ContextMenu`/`MenuItem`, `PageTabs` tabMenu, `ThreadPanel` header), expected
   files, diff budget (§5.5).
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
2. Popping a tab out: close the main tab (proposed) or keep both (Slack)?
3. Linux/Windows: accept "closing main closes pop-outs" for S1?
4. Is S1 = threads only acceptable as the first PR, with channels/DMs/Solo in S2?
5. Does this belong in `block/buzz-app` core (recommended; needs native) or
   should the entry points also be exposed to plugins later (`ctx.windows.open`)?
   Core first; plugin API only on demand.
6. Window title/branding for pop-outs ("Thread — #channel — Buzz"?), and
   whether the pop-out should show the member avatar stack or only the name.
