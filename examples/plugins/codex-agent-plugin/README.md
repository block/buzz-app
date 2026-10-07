# Codex agent plugin

A Buzz plugin backed by `codex app-server`. Create agent → Codex offers the installed
app server's model catalog and each model's supported thinking levels. Conversation context uses Buzz's saved agent setting: an entire
channel or each thread, with DMs always sharing one session. It uses your
existing Codex sign-in; no API key is stored in Buzz.

## Build and try

From the Buzz repository root, with the pinned tools:

```sh
bin/node examples/plugins/codex-agent-plugin/build.mjs
bin/pnpm exec tsc --noEmit -p examples/plugins/codex-agent-plugin/tsconfig.json
bin/pnpm exec vitest run --config examples/plugins/codex-agent-plugin/vitest.config.ts
```

Install Codex, run `codex login`, and ensure `codex` is on the desktop app's PATH.
Start this Buzz desktop build. In Settings → Plugins, load the `dist` folder under
this example and enable **Codex agent**. Create an agent with type **Codex**, choose
its model, thinking level and workspace, and add it to a channel where you can
mention it.

- A regular mention (or `/queue` after the mention) waits for earlier work in that
  conversation context. Other contexts have independent sessions.
- As the owner, `@Your agent /steer …` changes an active turn without starting
  another. Accepted steering updates the final reply destination to the steering
  message's thread, including when channel context spans threads. If Codex has
  finished, Buzz asks you to send an ordinary mention.
- `@Your agent /stop` interrupts the current turn and discards waiting work in
  that conversation. A subsequent mention resumes the same Codex thread.
- As the owner, `/reset` forgets an idle conversation’s session binding. The next
  mention starts a fresh session; its previous Codex history is retained. If work
  is active, use `/stop` first.
- Each turn has 29 minutes of active work; waiting in the conversation queue does
  not consume that budget. Timeouts publish an explanation.
- Stop also terminates Codex's background terminals before acknowledging cancellation.
  Edit, deletion, plugin disable, session replacement and timeout close stdin so
  app-server can shut down its tools. Native allows three seconds for graceful
  shutdown, then kills the remaining process group.

Codex runs with `workspace-write`, network disabled in the workspace sandbox and
`approvalPolicy=never`. Escalations and interactive tool questions are rejected;
they are not automatically approved. macOS and Linux are supported by the native
process transport; Windows needs a process-tree implementation before use.

## Prompt and activity contract

`src/base-prompt.md` is copied verbatim from `block/buzz` revision
`95b018c8713be9beebbd2517ace48529e3c0e6ed`,
`crates/buzz-acp/src/base_prompt.md` (the host runtime pin).
It is sent as Codex `baseInstructions`, followed by the plugin delivery adaptation
and the agent's instructions. It is not placed in a user message. The adaptation
makes final assistant text the published reply and explicitly replaces CLI-based
publishing: this plugin does not hand Buzz signing keys to Codex or grant general
Buzz CLI access.

Each turn has `<context>` with channel and reply routing and a `<buzz-event>` with
the current message. Each ordinary turn and steer also reads up to 50 recent
messages from the configured thread/channel through the owner’s verified relay
session, with author edits/deletions applied (up to 500 auxiliary events). The
snapshot is bounded by the triggering event’s timestamp, excludes that event,
and truncates individual messages at 4,000 characters. It is JSON quoted in
`<thread-context>` or `<conversation-context>`, separate from the current request.
Moderator deletions and complete long-history retrieval are not implemented.
Steering uses `<new-message-arrived-while-you-were-working>`.
Messages are JSON quoted inside these sections. Native Codex tools perform shell
and filesystem work; item IDs map to one live Buzz row per message, thought,
command, read, search or file edit. Text and reasoning delta notifications are
disabled at initialization (and ignored if received). Activity updates with
completed message, command-output and reasoning-summary snapshots, without token streaming. The final reply is published once, only after
a successful turn, through Buzz's existing native signing path.

Each start/resume calls `thread/name/set` with the Buzz channel name, an abbreviated
thread ID for thread context, and the agent name. The host resolves context from
the saved setting and Agent defaults; a missing channel name falls back to its ID.
All inherited MCP servers, Codex plugins and Apps tools are disabled for this
session without editing the user's global configuration. This includes
`buzz-dev-mcp`. Shell/read/write calls use Codex's native tools.

Only session IDs and a workspace/identity signature are stored in device-local
storage, scoped by community, agent and conversation. Codex stores its own history.
Model/thinking/instruction changes resume the conversation; changing the context
setting selects its corresponding channel/thread session. Changing workspace
starts a fresh session. Resume failures are surfaced instead of silently losing
history; the owner can explicitly recover with `/reset`. This plugin retains the host's existing limits: 16 deliveries per agent,
32 waiting deliveries, local progress visible only in the active window, and no
catch-up while the app is closed. Two owner steering requests and one stop request
have independent bounded admission so an ordinary queue cannot block cancellation.
Live activity disappears after the run, as in the AI SDK example.

## Real Codex acceptance

```sh
bin/node --experimental-strip-types examples/plugins/codex-agent-plugin/test/live.mjs
```

This opt-in test uses the existing Codex login and makes real model calls. It uses
`gpt-5.6-luna` by default; set `BUZZ_CODEX_TEST_MODEL` to an available model to change
it. It creates a disposable temporary workspace and no relay messages. It exercises
shell/file tools, idle steering, steering during a fixture gate (including between
threads in channel context), queuing, interruption,
lifecycle cancellation, recovery, resume and
inspects the actual Codex rollout for system-prompt placement and turn framing.
It also checks persisted session names, channel-session reuse, no streamed response
text deltas, updated instructions on resume, and configured MCP fixtures
(including a dotted server name) that must never start. Configuration values
are omitted from evidence. It prints the workspace and local evidence path. Never commit those raw records.

The native transport has a separate opt-in acceptance test. It uses the actual
Tauri process commands and channel with a real Codex bash/write/read turn. It also
revokes an active session, verifies its background shell PID exits, then releases
the shell's gate and checks that its cancelled write never happens:

```sh
bin/cargo test -p buzz-foundation --lib host_process::tests::real_codex_uses_native_transport_and_tools -- --ignored --nocapture
```

This test does not exercise identity startup or relay signing. Those boundaries
were exercised separately in the native app as recorded below. Desktop checks
must be repeated after changes affecting the corresponding path.

## Visual check

After building the plugin, start the local Vite server and open
`/examples/plugins/codex-agent-plugin/test/preview.html`. This mounts the real
Create agent dialog with the built plugin and a fixture model catalog. Choose
Codex, change Model and Thinking, and verify the workspace requirement. It does
not create an identity or publish messages. Load the live test's local
`evidence.json` to step through real Codex item events in Buzz's activity component.
No evidence is uploaded.


## Review findings and acceptance record — 2026-10-07

The external review was source-only and predates the completed native app checks.
It correctly identified missing unmentioned conversation history, silent idle
Stop/empty completion, missing completed command output, and SVG lint errors.
These are now addressed. Icons import the original Tabler assets through Buzz’s
design-system gateway; colors belong to the plugin presentation. Timeout errors
no longer suggest resetting healthy sessions; only failed resumes suggest `/reset`.
The host now replies to denied non-owner controls within its existing rate budget.
A valid settings edit that replaces an active instance posts a host notice through
the replacement identity; the revoked plugin still cannot publish. Changes that
remove publishing authority (deletion, disable, community replacement or invalid
configuration) cannot promise a final relay message.

### What was actually exercised

- **Native desktop + live relay:** created **Codex Test** in the user-created
  **codex-plugin-test** channel, selected GPT-5.6-Luna / Low, set a workspace and
  custom instructions, mentioned it, and observed a signed reply in the correct
  thread after native shell write/read. Inspected the native Create/Edit UI and
  Codex badge. The activity panel showed the active command and queued request.
- **Mid-turn controls in the native app:** a file gate held the current command.
  Accepted steering changed the subsequent destination file; a queued request ran
  afterward. The original destination was never created. Idle steering returned
  an explanation. Ordinary recovery reused the Codex conversation.
- **Actual Codex rollout:** verified the pinned Buzz prompt verbatim at the start
  of `base_instructions`, followed by custom instructions; model and effort in
  turn context; Buzz event/steering framing; native tools; and a name containing
  the Buzz channel, thread abbreviation and agent name.
- **Cancellation defect found in desktop testing:** the first `/stop` ended the
  turn but left a background terminal alive; releasing its gate allowed a write.
  This was a real failure, not a passing cancellation check. The fix explicitly
  terminates background terminals and checks termination before acknowledging
  Stop, and native shutdown delivers EOF before its bounded kill fallback.
- **Cancellation fix acceptance:** the opt-in Rust test passed against the actual
  Tauri process transport and real Codex: after revocation, the shell PID exited
  and releasing the gate could not create the forbidden file. The real plugin
  acceptance test separately passed interruption, lifecycle cancellation,
  subsequent recovery, steering/queueing, updated instructions on resume and MCP
  isolation. The final desktop rerun after rebuilding was blocked by macOS
  Keychain startup and then a locked Mac; it is **not claimed as passed**.

Raw rollouts, relay records and evidence files remain outside the repository.
The process-group fallback has a limit: if Codex does not exit within the three
second grace period, a separately grouped descendant may outlive the fallback.
Windows process-tree cancellation has not been implemented or tested.

### Capability checklist disposition

| Story | Status and remaining work |
| --- | --- |
| Choose/configure | Model and supported thinking choices work. Blank fields use Codex defaults, not Buzz’s model defaults. Save already warns that it restarts the agent; active valid edits now also post an interruption notice. |
| Sign in | Uses the existing Codex login. No Buzz sign-in or API-key form. Credentials stay in Codex. |
| Message → reply | Native signed reply verified. Error, timeout, resume, steer rejection, idle stop and empty completion have feedback. Revoked identities cannot promise relay delivery. |
| Activity | Native progress verified. Empty reasoning rows removed; completed command output now included. No output streaming by design. Shared/persisted activity requires host support. |
| Talk while working | Native queue and steer verified; cancellation fix verified through real native transport. Owner-only control preserved. Redirect, activity Stop button and per-agent default action remain host follow-ups. |
| Base prompt | Verified in a real rollout, including updated custom instructions on resume. The verbatim pinned base retains CLI wording; the appended adapter explicitly replaces CLI publishing with the signed host reply. |
| Follow-ups | Codex session reuse verified; fresh bounded thread/channel history now includes unmentioned messages. Bindings are device-local. New relay history wiring still needs a native UI rerun. |
| Sessions page | Codex thread names verified. Buzz Sessions listing, rename propagation and reopen are not integrated. |
| Cost | Token usage notifications are not yet collected by this plugin; cost/context display and persistence remain follow-ups. Unknown cost must not be reported as zero. |

Inherited MCP servers, Apps and Codex plugins remain disabled intentionally.
Arbitrary channel authors can mention the agent; inheriting the owner’s credentialed
integrations would grant them unintended access. A harness-tool opt-in needs an
explicit product/security decision. Native shell/read/write tools work without
`buzz-dev-mcp`. Interactive approvals and lifecycle hooks remain unsupported.

### Focused regression evidence for this review round

New assertions reproduced the old missing idle/empty replies, absent command
output, missing history in the actual `turn/start` input, silent non-owner denial,
and silent settings replacement, then passed after the fixes. History tests cover
thread versus channel scope, author edits/deletions, forged edits and delimiter
quoting. They use the plugin/host boundaries; no new browser journey was added.
The native UI rerun and CI remain deferred; local tests do not establish that the
full capability checklist is complete.

Current review snapshot: **16 plugin tests and 24 agent-type/host tests passed**;
root and plugin TypeScript checks, plugin build, frontend build, focused Biome
check, icon boundary and `git diff --check` passed. The real Codex acceptance was
rerun after the steering-order fix and passed all scenarios, including recalling
an unmentioned history fact. That history source was a relay-shaped fixture; it
does not substitute for the deferred native relay-history UI check. Independent
review rated the bounded fixes 9/10 with no remaining material blockers.

The browser preview was also checked with real captured Codex item events:
completed command labels and output render together, and the Codex badge remains
visible in Create agent. This is browser fixture evidence, not another native
app run. The installed desktop bundle still needs rebuilding/reloading for the
latest host notices before that deferred native check.
