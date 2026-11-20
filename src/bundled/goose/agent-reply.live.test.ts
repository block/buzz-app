// @vitest-environment node
// Starts a managed Goose agent, mentions it in a channel of a real relay and
// waits for its reply. Run by `scripts/agent-e2e.mjs` (the review rig's agent
// lane), which provides BUZZ_E2E_RELAY (the relay's http origin) and
// GOOSE_ACP_BIN (the staged goose-acp).
//
// Real: the relay, the agent's and owner's signed events, `GooseRuntime` with
// the mention's prompt and session, the shared ACP client and its permission
// answers, `goose-acp`, the loopback MCP server, and the Buzz `send` tool.
// Scripted: the model, a local OpenAI-compatible server that answers every
// turn with one `buzz__send` call. Not covered: the desktop's relay
// subscription that wakes an agent (the mention is read back from the relay and
// handed to the runtime), native key custody and the Tauri process host.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { afterAll, describe, expect, it } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import { nodeClient, relayAuthorityLookup } from "../../buzz-mcp/node";
import { callTool } from "../../buzz-mcp/tools";
import { memoryStorage } from "../../features/agents/test-fakes";
import type { AgentHandle, Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { hits, liveSpawn, serve } from "./goose-live-host";
import { DEFAULT_CONFIG, GooseRuntime } from "./runtime";

const RELAY = process.env.BUZZ_E2E_RELAY;
const BIN = process.env.GOOSE_ACP_BIN;
const WAIT_MS = 90_000;

const until = async <T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeout = WAIT_MS,
) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

/** A model that answers every turn with one `buzz__send` of `pong <nonce>`,
 * where the nonce is the one in the owner's mention, then says it is done. It
 * answers in words only when goose did not offer `buzz__send`. `requests`
 * records what goose asked it, and what its tool call returned. */
async function scriptedModel() {
  const requests: {
    tools: number;
    send: boolean;
    last: string;
    toolResult?: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "gpt-4o", object: "model" }],
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {
      messages: { role: string; content?: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    const tail = input.messages.at(-1);
    const last = tail?.role ?? "";
    // Like any model, it can only call a tool goose offered it.
    const send = (input.tools ?? []).some(
      (tool) => tool.function?.name === "buzz__send",
    );
    requests.push({
      tools: (input.tools ?? []).length,
      send,
      last,
      // What the agent's tool call came back with, when it made one.
      ...(last === "tool"
        ? { toolResult: JSON.stringify(tail?.content).slice(0, 300) }
        : {}),
    });
    const nonce = /e2e-[0-9a-f]{8}/.exec(body)?.[0] ?? "no-nonce";
    const delta =
      last === "tool" || !send
        ? {
            role: "assistant",
            content: last === "tool" ? "done" : "I have no tool to send with",
          }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "send-reply",
                type: "function",
                function: {
                  name: "buzz__send",
                  arguments: JSON.stringify({
                    text: `pong ${nonce}`,
                    audience: "everyone",
                  }),
                },
              },
            ],
          };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      {
        index: 0,
        delta: {},
        finish_reason: last === "tool" || !send ? "stop" : "tool_calls",
      },
    ])
      response.write(
        `data: ${JSON.stringify({
          id: `response-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [choice],
        })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The scripted model has no address");
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const person = () => {
  const secret = generateSecretKey();
  return { secret: bytesToHex(secret), pubkey: getPublicKey(secret) };
};

describe.skipIf(!RELAY || !BIN)("a managed agent answers a mention", () => {
  const home = mkdtempSync(join(tmpdir(), "buzz-agent-e2e-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("replies in the thread of the owner's mention, through the relay", {
    timeout: 3 * WAIT_MS,
  }, async () => {
    const relay = RELAY as string;
    const ownerKey = person();
    const agentKey = person();
    const lookup = relayAuthorityLookup(relay);
    const client = (key: string): BuzzClient => ({
      ...nodeClient({ relay, key, root: home }),
      relayAuthorLookup: lookup,
    });
    const owner = client(ownerKey.secret);
    const as = client(agentKey.secret);
    const tool = (
      who: BuzzClient,
      name: string,
      args: Record<string, unknown>,
    ) => callTool(who, {}, name, args);

    // The owner opens a channel with the agent in it and mentions the agent.
    const created = String(
      await tool(owner, "channel_create", {
        name: `agent-e2e-${Date.now()}`,
        visibility: "open",
      }),
    );
    const channel = /created ([0-9a-f-]{36})/.exec(created)?.[1];
    if (!channel) throw new Error(`No channel was created: ${created}`);
    await tool(owner, "member_add", { channel, pubkeys: [agentKey.pubkey] });
    const nonce = `e2e-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
    await tool(owner, "send", {
      channel,
      text: `Please reply with a short pong. Code: ${nonce}`,
      mentions: [agentKey.pubkey],
      audience: "everyone",
    });

    // The agent hears the mention from the relay, as its harness does.
    const mention = await until("the mention to reach the agent", async () =>
      (
        await as.query([
          { kinds: [9], "#h": [channel], "#p": [agentKey.pubkey], limit: 10 },
        ])
      ).find((event) => event.content.includes(nonce)),
    );

    const model = await scriptedModel();
    const env: Record<string, string> = {
      OPENAI_API_KEY: "local-test-only",
      OPENAI_HOST: `http://127.0.0.1:${model.port}`,
      OPENAI_BASE_PATH: "v1/chat/completions",
      GOOSE_DISABLE_SESSION_NAMING: "true",
      GOOSE_PATH_ROOT: join(home, "goose"),
    };
    const saved = Object.fromEntries(
      Object.keys(env).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, env);
    delete process.env.OPENAI_BASE_URL;

    const host = {
      spawn: liveSpawn(BIN),
      resolveDirectory: async (path: string) => path.replace(/^~/, home),
      readFile: async () => {
        throw new Error("No file reads in this check");
      },
      serveMcp: serve,
      request: async () => undefined,
    } as unknown as Host;
    const session = {
      read: (filters: readonly Record<string, unknown>[]) =>
        owner.query(filters),
      agentMemories: {
        open: () => ({
          snapshot: () => ({ status: "ready", listing: { entries: [] } }),
          subscribe: () => () => {},
          refresh: async () => {},
          dispose: () => {},
        }),
      },
      channels: {
        list: () => ({
          channels: [
            {
              id: channel,
              name: "agent-e2e",
              channelType: "stream",
              members: [],
            },
          ],
        }),
      },
      names: { resolve: () => "" },
      profiles: { ensure: async () => {}, snapshot: () => new Map() },
      channelWrites: { startingCanvas: () => undefined },
      canvas: { available: false, read: async () => null },
    };
    const connection = {
      snapshot: () => ({
        status: "ready",
        session,
        viewer: ownerKey.pubkey,
        origin: relay,
        scope: `${relay}:${ownerKey.pubkey}`,
      }),
      subscribe: () => () => {},
    } as unknown as RelayData;
    const runtime = new GooseRuntime(
      host,
      () => connection,
      async () => undefined,
      memoryStorage(),
      () => [],
      undefined,
      memoryStorage(),
    );
    const agent = {
      ...as,
      key: agentKey.pubkey,
      pubkey: agentKey.pubkey,
      name: "Gander",
      owner: ownerKey.pubkey,
      relay: relay.replace(/^http/, "ws"),
      remember: async () => {},
    } as unknown as AgentHandle;

    let settled: PromiseLike<unknown> | undefined;
    let ignored: unknown;
    try {
      await runtime.run({
        trigger: { type: "mention", event: mention as RelayEvent },
        channelId: channel,
        agent,
        config: {
          ...DEFAULT_CONFIG,
          provider: "openai",
          model: "gpt-4o",
          workspace: home,
        },
        signal: AbortSignal.timeout(2 * WAIT_MS),
        workingUntil: (done: PromiseLike<unknown>) => (settled = done),
        ignored: (refusal?: unknown) => (ignored = refusal ?? "ignored"),
      } as unknown as Delivery);

      // What the run says if no reply arrives, so a failure names its step.
      const account = async () =>
        JSON.stringify({
          ignored,
          settled: settled
            ? await Promise.race([
                settled,
                new Promise((resolve) => setTimeout(resolve, 50, "pending")),
              ])
            : "never handed off",
          modelRequests: model.requests,
          mcpHits: hits.length,
        });
      // The turn's own outcome ends the wait early: a turn that failed, or
      // finished without a reply, will not produce one later.
      let turn: { ok?: boolean; error?: unknown } | undefined;
      void Promise.resolve(settled).then(
        (result) => (turn = (result ?? {}) as typeof turn),
        (error: unknown) => (turn = { ok: false, error }),
      );
      let turnEndedAt: number | undefined;
      const reply = await until("the agent's reply", async () => {
        const found = (
          await owner.query([
            { kinds: [9], "#h": [channel], authors: [agentKey.pubkey] },
          ])
        ).find((event) => event.content.includes(nonce));
        if (found) return found;
        if (turn?.ok === false)
          throw new Error(
            `The agent's turn failed before it replied: ${String(turn.error)}`,
          );
        if (turn) {
          // Allow the relay a moment to show a reply published as the turn ended.
          turnEndedAt ??= Date.now();
          if (Date.now() - turnEndedAt > 10_000)
            throw new Error("The agent's turn finished without a reply");
        }
        return undefined;
      }).catch(async (error: Error) => {
        throw new Error(`${error.message}. Run state: ${await account()}`);
      });
      expect(reply.content).toBe(`pong ${nonce}`);
      // A reply lands in the mention's thread, as the desktop's does.
      expect(reply.tags).toContainEqual(["h", channel]);
      expect(reply.tags.some((tag) => tag[0] === "e")).toBe(true);
      console.log(
        `agent-e2e: reply ${reply.id} from ${reply.pubkey.slice(0, 12)} to mention ${mention.id.slice(0, 12)}: ${JSON.stringify(reply.content)}`,
      );
    } finally {
      runtime.dispose();
      await model.close();
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });
});
