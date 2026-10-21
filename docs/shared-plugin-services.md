# Shared services for plugins

Plugins use `ctx.relay` and `ctx.agents`. Declare both in `inject`.
Use the host-matched `@buzz/author` types. See [plugin architecture](plugin-architecture.md).

Bind each action and view to the current ready connection. Reject cached-only
connections for writes. Stop subscriptions when the plugin or connection ends.
See [relay query ownership](relay-queries.md).

| Operation | Existing owner |
| --- | --- |
| Create a channel | `session.channelCreation.create` |
| Select an agent | `session.agentChoices.snapshot().selectable` |
| Create a conversation channel | `session.channelWrites.start` |
| Post a message | `session.messages.send` |
| Read conversation messages | `session.read` or `session.thread` |
| Read artifact heads or history | `session.snapshotRead` |
| Write an artifact | `session.outbox.send`, kind `45010` |
| Receive artifact changes | `session.subscribeLive` |
| Stop a local session | `ctx.agents.session(pubkey, { channelId }, "interrupt")` |

## A plugin action

This action creates two private channels. The viewer owns the first channel.
The second channel is a Solo conversation with one local agent.
The note records the conversation ID. The caller owns its returned operation ID.

```ts
import type { Context } from "@buzz/author";

export async function startExample(ctx: Context, primary: string) {
  const connection = ctx.relay.snapshot();
  if (connection.status !== "ready" || connection.cached || !connection.viewer)
    throw new Error("Connect to a community first");
  const { session, viewer } = connection;
  const outbox = session.outbox;
  if (!outbox?.supports(45010))
    throw new Error("Artifact writes are unavailable");
  const choice = session.agentChoices.snapshot().selectable.find(
    (agent) => agent.pubkey === primary && agent.managed,
  );
  if (!choice) throw new Error("Choose a local agent");

  const home = await session.channelCreation.create({
    name: "Example", visibility: "private",
  });
  const channelId = crypto.randomUUID();
  const { ready } = session.channelWrites.start(
    channelId, "Example session", [viewer, primary],
  );
  await ready;
  await session.channelWrites.refresh(channelId, { member: primary });
  const message = session.messages.send(channelId, "Hello", [primary]);
  const d = crypto.randomUUID();
  const operation = outbox.send({
    kind: 45010,
    content: JSON.stringify({ channelId }),
    tags: [
      ["ar", "1"], ["h", home], ["d", d],
      ["type", "example.note"], ["title", "Example"], ["op", "create"],
    ],
  });
  return { home, channelId, d, message, operation };
}
```

These steps are separate writes. Keep confirmed IDs after a later step fails.
A returned outbox ID means that the operation is queued. Observe `outbox.snapshot`
and `outbox.subscribe` for delivery. Inspect the error for `failed` operations.
`unknown` leaves acceptance uncertain. Retry the same operation to resolve it.
The relay enforces channel access and artifact head conflicts.

## Artifact reads and live changes

Use `snapshotRead` for authoritative artifact queries. It returns the relay's
verified response without local intent or retained revisions. For example:

```ts
if (!session.snapshotRead) throw new Error("Artifact reads are unavailable");
const heads = await session.snapshotRead([
  { kinds: [45010], "#h": [home], artifact: "current", limit: 100 },
], { signal });
```

Use `offset` for later pages. Use `artifact: "history"` with `#h` and `#d`
for revision history. Explicit artifact queries do not accept `consistency`.
An ordinary read of one head can use `consistency: "strong"` without `artifact`.

To update an artifact, keep its `d`, `h`, and `type`. Set `op` to `update`
and `prev` to the observed head's event ID. A conflict requires a fresh head
read and a client decision. Do not replace `prev` and repeat the write blindly.
Acceptance does not prove that the revision remains current; read the head again.

`subscribeLive` supplies verified artifact events for channels in the shared live
interests. Use these events to refresh affected queries. Include replay with
`{ replay: true }` when needed. Deduplicate by event ID. Live replay is bounded;
refresh finite queries after reconnect and when a view opens. Do not use
`session.observe` as an authoritative projection of current artifact heads.
Its generic event merge does not interpret artifact revision semantics.

## Local agent sessions

A Solo channel gives the agent one conversation at channel level. A mention
starts or continues that conversation through the existing runner. Use explicit
mentions for the plugin's primary responder. A saved primary role does not change
the runner's rules. Model and effort choices can use the existing message picks.

`ctx.agents.sessionState` reports whether session controls are available.
`ctx.agents.session(..., "interrupt")` acts in the app that runs the agent.
It does not delete the conversation. See [agent controls](agents.md).

Shared message reads return the Buzz conversation. Full harness transcripts have
separate Claude, Codex, and goose readers. They remain with each harness and are
not a shared external plugin API. This service path does not promise execution
after the app closes. Tasks, session bindings, parent references, and schemas
belong to the consumer plugin.
