# Codex for Agents2

An installable desktop plugin based on the native plugin-process host in #731.
Agents2 owns the identity, admission, configuration, and signed reply. This plugin
owns Codex work after delivery handover. It starts one `codex app-server` per agent
and uses independent Codex threads for Buzz conversations.

## Try it

From the feature worktree:

```sh
bin/pnpm plugin:codex
BUZZODZ_PROFILE=codex-agents2 BUZZ_DEV_VIEWER= bin/just desktop
```

1. Open **Settings → Plugins → Load from folder**. Choose this worktree's
   `dist-plugins/codex`, install it, and turn it on. Rebuild and import that folder
   again after plugin source changes; frontend hot reload does not update an
   installed plugin.
2. Open **Agents2 → New agent**, choose **Codex**, and create an agent. The Codex
   tab checks the installed CLI and existing account. If needed, install Codex
   and run `codex login` in a terminal, then click **Check again**.
3. In the agent's **Settings** tab, set an absolute **Workspace** path. A
   disposable directory is useful for the first test. Choose model, thinking,
   session scope, and instructions, then **Save**.
4. Mentions and replies are automatic; **Attention** also lets you add event
   watches. In a channel you can write to, select the agent from the `@` picker
   and add it to the channel if prompted. Send: `@Codex Test create hello.txt containing
   hello in the workspace, read it back, and report what you found`. Use the
   agent's actual name. Expect one reply from that agent in the originating
   thread and the file in your workspace.
5. Reply in the same thread: `@Codex Test read hello.txt and remind me what you
   wrote`. Expect the same Codex session and correct file contents.

While work is active, ordinary mentions queue. Explicit controls follow the
mention, for example `@Codex Test /stop`:

- `/queue <request>` queues a follow-up, like an ordinary mention.
- `/steer <request>` redirects the active turn; the final reply targets the last
  accepted steering message. Rejected steering gets feedback.
- `/stop` interrupts the turn, waits for background terminals to terminate,
  verifies cleanup, and cancels queued requests. A new mention can continue.
- `/reset` discards the conversation binding after work stops. The next mention
  starts a fresh Codex thread; Codex's stored history is retained.

For cancellation, ask it to run `sleep 30` before creating a file, then send
`/stop` after the command appears in the Codex tab. Expect a stopped reply, no
later file, and successful response to a fresh mention. For settings, change
instructions to require a marker, save, and send another mention in the same
thread. Expect the marker. Queued work keeps its original settings.

Thread scope is the default. Channel scope shares a session across channel
threads; DMs always share a conversation. Workspace changes start a fresh session.
Bindings persist locally under the community and agent identity. Switching
communities, removing an agent, or disabling the plugin ends its server.

## Checks

```sh
bin/pnpm exec vitest run src/agent-plugins/codex
bin/node src/agent-plugins/codex/live.mjs
```

The opt-in live check uses the installed Codex CLI/account in a disposable
workspace and a simulated relay. It sends no Buzz messages. It checks native shell
and file tools, the base prompt, conversation context, accepted steering, queued
follow-ups, cancellation of background shells, recovery, saved-thread reuse,
changed instructions, and disabled inherited MCP tools. Set
`BUZZ_CODEX_TEST_MODEL` to another available model if needed. It prints only
sanitized outcomes; it does not save raw protocol or session logs.

Automated component tests cover model/effort choices, unavailable saved choices,
workspace validation, pending saves, and closing a process returned after unmount.
Protocol tests cover chunking, request correlation, interactive request rejection,
malformed output, and consumer exception containment. Runtime tests cover
conversation routing, controls, persistence, defaults, failures, and cleanup.

## Limits and boundaries

- Only the owner's events start work. Event watches support those events; timers
  are unsupported and report an error.
- Replies use Agents2's host signer. Codex receives no Buzz agent key and does not
  publish through the Buzz CLI. The base prompt is adapted from #698; its CLI
  publishing instructions are replaced by final-text publication through the host.
- Codex uses workspace-write with no network access and approval policy `never`.
  Inherited MCP servers, Apps, and plugins are disabled. The declared native
  process grant itself has full user access; the Codex sandbox governs its tools.
- Shared Agent Activity integration is deferred because this Agents2 delivery
  contract has no live-activity API. The Codex tab shows conversation status and
  the latest command/output. Responses are published once, without text streaming.
- Each conversation allows 32 queued requests. Turns have a 29-minute deadline;
  RPC acknowledgements have a 30-second deadline. Local bindings retain 200 sessions.
- Uses experimental app-server APIs for model discovery and background terminal
  cleanup. The live check was exercised with `codex-cli 0.153.0` on macOS.
- Linux and Windows native behavior, packaged app behavior, full relay signing,
  and human acceptance require separate validation. A forced native kill can
  depend on the platform's descendant-cleanup support; this plugin adds no host
  process implementation.

Keep the PR in draft until the agent and human exercise the native mention/reply
flow, including signer behavior and cancellation. Do not add
`buzz-review-completed` before the repository's review checklist holds.
