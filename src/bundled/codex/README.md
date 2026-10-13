# Codex for Agents

A bundled desktop plugin, on by default on macOS and Linux, using the native process host introduced in #731.
Agents owns the identity, admission, configuration, and signed Buzz actions. This plugin
owns Codex work after delivery handover. Agents share one `codex app-server` per storage home, with an independent Codex thread for each agent's Buzz conversation.
Each thread carries its agent's workspace, instructions and tools, so one crash
fails every agent's current turn; the next mention reopens the server.

## Try it

From the feature worktree:

```sh
source bin/activate-hermit
BUZZODZ_PROFILE=codex-agents BUZZ_DEV_VIEWER= bin/just desktop
```

1. Codex is on by default; **Settings → Plugins** turns it off or on. An older
   profile that installed Codex from a folder gets the bundled copy instead, and
   keeps it off if the installed copy was off.
2. Open **Agents → New agent**, choose **Codex** in the card's top corner, and
   optionally pick a model beside it and add instructions. Name the agent and
   click **Create agent**. The Codex tab checks the installed CLI and existing
   account. Install Codex if needed. File-based sign-in is shared with the existing Codex home. For keyring sign-in, use the Buzz-specific login command shown in the Codex tab, then click **Check again**.
3. The **Workspace** defaults to `~/.buzz`, like Claude. In the agent's
   **Settings** tab, you can set an absolute path instead; clearing it restores
   the default. A disposable directory is useful for the first test. Choose model, thinking,
   session scope, and instructions, then **Save**.
4. Mentions are automatic; **Attention** also lets you add event
   watches. In a channel you can write to, select the agent from the `@` picker
   and add it to the channel if prompted. Send: `@Codex Test create hello.txt containing
   hello in the workspace, read it back, and report what you found`. Use the
   agent's actual name. Expect one reply from that agent in the originating
   thread and the file in your workspace.
5. Reply in the same thread: `@Codex Test read hello.txt and remind me what you
   wrote`. Expect the same Codex session and correct file contents.

While work is active, new mentions steer it, incorporating the follow-up into the
ongoing task. Messages arriving during startup wait for the turn to start and
then steer it; idle conversations continue the saved session. If a turn finishes
while a follow-up is being delivered, the follow-up starts another turn. A
follow-up that picks a model or effort other than the running turn's cannot
steer it, so it waits and runs as the next turn, and later follow-ups wait
behind it to keep their order.
A successful final send stops the request counting as working at once; Codex
still ends its turn with one more model call. Interrupting the turn instead would
leave a `<turn_aborted>` note in the session after every reply.
By default, Buzz tools reply to the latest accepted steering message. The agent can also choose another thread or channel with tool arguments.

There are no special chat commands. Asking the agent to stop is a steering request
that Codex interprets. Disabling the plugin ends its processes. For settings,
change instructions to require a marker, save, and send another mention after the
current turn finishes. Expect the marker.

Thread scope is the default. Channel scope shares a session across channel
threads; DMs always share a conversation. Workspace changes start a fresh session.
Bindings persist locally under the community and agent identity. Earlier bindings without dynamic tools are ignored; new conversations start fresh. Switching
communities does not end an agent's work. Removing the agent, leaving or
disconnecting from its community interrupts its turns and asks Codex to end
shells they left running; the server ends when no
Codex agent that has worked is still running, or when the plugin is disabled.
If a saved Codex thread no longer exists, the next mention starts a fresh one.
To inspect a saved session, see [View a Codex session](../../../docs/view-codex-session.md).

The `buzz` dynamic-tool namespace exposes the same handlers as the Claude plugin:
`send`, `edit`, `react`, `read`, `channels`, `members`, `users`, `dm`, `mem_get`,
`mem_set`, `canvas`, and `media_get`, which answers with the image itself. These run inside Buzz through the agent's native-backed
handle; no MCP process or Buzz credentials go to Codex. Shared file tools use the
workspace where the turn started, through the declared `base64` reader. Memory
reads use the owner's encrypted-memory view; writes use the agent handle.

To test these locally, ask the agent to read its thread, react to your message,
remember a fact under `mem/test`, recall it in a follow-up, and send an image from
the workspace. Expect agent-signed actions, correct thread routing, and one final
reply. During a long task, send a new mention and confirm it incorporates the
follow-up before its final reply.

## Conversation storage

New conversations use `~/Library/Application Support/Buzz/codex` on macOS, or `${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex` on Linux. The launcher links only `config.toml`, `auth.json`, `AGENTS.md`, `rules`, and `skills` from the existing `CODEX_HOME` (default `~/.codex`); credentials are not copied. An explicit private `sqlite_home` override prevents shared configuration or `CODEX_SQLITE_HOME` from routing new database state back to desktop. Rollouts, paginated history and other runtime state remain private. File-based sign-in and refresh retain the existing shared file. Keyring credentials are scoped to the home and may require a separate Buzz sign-in.

Existing v4 bindings without a store marker keep their original home, native context, tool history and transcript. Those conversations remain visible in Codex desktop and continue updating there. Bindings retain their history because Codex has no complete supported migration for paginated history. New bindings persist their store marker; workspace changes and recovery from a genuinely deleted thread create an isolated session. Conversation scope follows the configured thread/channel/DM policy. Legacy and isolated servers start lazily and retain background terminals until the existing agent/plugin shutdown boundary.

Conflicting private configuration files or links to a different shared home stop setup with a diagnostic instead of overwriting either setup. The private home lives outside the default agent workspace.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/codex
bin/node src/bundled/codex/isolation-live.mjs
bin/node src/bundled/codex/live.mjs
```

The isolation check runs real Codex processes against disposable homes, a synthetic file-based account and a loopback fixture model. It verifies independent thread listings, private SQLite state despite inherited overrides, shared sign-in/configuration, persistence after restart, and unchanged legacy history. It sends no external model or relay requests.

The opt-in live check uses the installed Codex CLI/account in a disposable
workspace and a simulated relay. It sends no Buzz messages. It checks native shell
and file tools, the native coding prompt, conversation context, default steering,
idle follow-ups, process shutdown, saved-thread reuse, changed and cleared
instructions, missing-thread recovery, and disabled inherited MCP tools. It also
checks real dynamic Buzz callbacks, memory, workspace file uploads, normal
final sends without aborted-turn markers, and two agents sharing one server with
their own workspace, instructions and replies. Set
`BUZZ_CODEX_TEST_MODEL` to another available model if needed. It prints only
sanitized outcomes; it does not save raw protocol or session logs.

Automated component tests cover model/effort choices, unavailable saved choices,
workspace validation, pending saves, and closing a process returned after unmount.
Protocol tests cover chunking, request correlation, interactive request rejection,
malformed output, and consumer exception containment. Runtime tests cover
conversation routing, ordinary message delivery, persistence, defaults, failures,
and cleanup.

## Limits and boundaries

- Only the owner's events start work. Event watches support those events; timers
  are unsupported and report an error.
- Replies use Agents' host signer. Codex receives no Buzz agent key and does not
  publish through the Buzz CLI. Short Buzz guidance and custom instructions are
  supplied as developer instructions, preserving Codex’s native coding prompt.
- Codex runs with sandbox `danger-full-access` and approval policy `never`, matching
  Claude's `bypassPermissions`: it can write outside its workspace, reach the
  network, and use git and `gh`. Web search, inherited MCP servers, Apps, and plugins
  are disabled.
- Shared Agent Activity integration is deferred because this Agents delivery
  contract has no live-activity API. The Codex tab shows conversation status and
  the latest command/output. Messages and uploads use the shared Buzz tools. Codex assistant text is not automatically posted. After `buzz.send` with `final: true`, Codex finishes normally and consumes pending steering. Final sends preserve background processes, such as a dev server it started.
- Turns have a 29-minute deadline;
  RPC acknowledgements have a 30-second deadline. Local bindings retain 200 sessions.
- Uses experimental app-server APIs for dynamic tools, model discovery, application context, and terminal
  cleanup. The live check was exercised with `codex-cli 0.162.0` on macOS.
- Linux and Windows native behavior, packaged app behavior, full relay signing,
  and human acceptance require separate validation. A forced native kill can
  depend on the platform's descendant-cleanup support; this plugin adds no host
  process implementation.

Keep the PR in draft until the agent and human exercise the native mention/reply
flow, including signer behavior and process shutdown. Do not add
`buzz-review-completed` before the repository's review checklist holds.
