# Amp

Create agents that run Amp on your computer and answer you in Buzz. Each conversation continues its own Amp thread.

## Getting started

1. Install [Amp](https://ampcode.com) and run `amp login` once.
2. Turn on **Amp** in **Settings** → **Plugins**.
3. Choose **New agent** → **Create a new agent** and pick **Amp** as the **Harness**.
4. Mention your agent in a conversation to give it work.

---

# Amp for Agents

A desktop plugin, off until turned on in **Settings → Plugins**. It runs the
`amp` CLI found on this computer's PATH (on macOS, `~/.local/bin` too), signed
in as `amp login` left it. Agents owns the identity, admission, configuration,
and signed Buzz actions; this plugin owns Amp work after delivery.

- Each conversation is one Amp thread, saved on this device: a Buzz thread,
  or the whole channel when **Sessions** says so, and always a DM or Solo
  chat. Each turn runs `amp threads continue <thread> --execute --stream-json`
  once, in the agent's **Workspace** (default `~/.buzz`), and its turns run
  one at a time. A thread Amp can no longer continue is started again.
  Threads are kept unarchived and titled `Agent · #channel`, so they also show
  in Amp's thread list.
- The Buzz tools are a loopback MCP server the app answers for each turn
  (`--mcp-config`), signed by the agent's native-held key; the `amp` process
  holds no Buzz key. Amp reaches them with its own `tool_search`. Continuing a
  thread, Amp connects once as it starts and again once the thread loads, but
  the server admits one session, so the Buzz tools refuse `initialize` until
  Amp reports the thread open. Amp retries and connects.
- Amp has no system prompt option, so Buzz's prompt opens each new thread, and
  opens the next turn again after it changes.
- Only the owner's events, or ones the owner delegated, start work. Amp runs
  with `--dangerously-allow-all`, like Claude's `bypassPermissions`. Watches
  and timers run as one-off Amp threads, which Amp archives.
- **Mode** picks Amp's agent mode (`--mode`); the composer's model picker
  offers the modes for one turn.
- **Stop** on a turn's activity stops its `amp` process, and posts nothing.
- A turn that answered in text and never called `send` has its answer posted in
  the thread. A turn that fails posts `⚠️ I couldn't finish that: …` and tags
  the owner.
- `BUZZ_MANAGED_AGENT=1` is set for `amp`, so Amp plugins that mirror threads
  to Buzz, such as amp-buzz, stay out of the way.

Not yet supported: steering a running turn (a newer mention waits for it), an
Activity transcript, usage, compact and new-session controls, resuming turns a
reload stopped, and Windows.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/amp
# Against the real `amp`, using Amp credits:
AMP_LIVE=1 bin/pnpm exec vitest run src/bundled/amp/amp.live.test.ts
```
