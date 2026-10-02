# AI SDK agent

A Buzz plugin that contributes one agent type, "AI SDK assistant", built on the
plugin agent types API (`ctx.agentTypes.register`) and the Vercel AI SDK.

An agent of this type answers when it is mentioned. Its answer is posted as a reply
in the mention's thread and grows there while the model writes it. The model has two
tools: `read_messages` (the thread or the channel, read through the owner's session)
and `post_message` (a separate message in the same channel, signed as the agent).

It needs an Anthropic or OpenAI API key, entered on the agent's settings form.

## Requires

A Buzz desktop build with both of these, neither of which is on `main`:

- plugin agent types: branch `art3/client-triggers`
- `ctx.host.fetch`: branch `art4/host-fetch`

Branch `art4/agent-sdk-try` has both. Without `ctx.host.fetch` the plugin still
loads and falls back to `ctx.host.request`: the answer then arrives in one piece, and
a model call that takes longer than 30 seconds fails.

## Build and test

```sh
npm install
npm run types   # generates @buzz/author types from the art3-client-triggers worktree
npm run check
npm test        # builds dist/, then runs the tests
```

`dist/` holds `manifest.json` and one self-contained `plugin.js`. Load that folder
from Settings → Plugins → Load from folder, then enable the plugin.

## Layout

- `src/plugin.ts`: the agent type, its settings form, and the wiring to `ctx`
- `src/run.ts`: one run, with the AI SDK `ToolLoopAgent` and the two tools
- `src/reply.ts`: the streamed reply, one message (kind 9) then edits (kind 40003)
- `src/thread.ts`: event tags, and folding edits and deletions into what a reader sees
- `src/host-fetch.ts`: the `fetch` handed to the AI SDK
- `src/config.ts`: the saved config

## Known limits

- The API key is part of the agent's config, which the app saves unencrypted and
  returns to the WebView with every agent snapshot.
- Reads use the owner's session, so the agent can read what its owner can. The
  tools are limited to the channel of the mention.
- A streamed answer writes one edit event to the relay about every 1.5 seconds.
- The agent must be a member of the channel to be mentioned and to post there.
- Moderator deletions (kind 9005) are not applied to what `read_messages` returns.
