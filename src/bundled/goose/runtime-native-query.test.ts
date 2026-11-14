// @vitest-environment jsdom
// Process/IPC, relay sessions/discovery, plugin status and protection UI are
// fixtures; client, runner custody and native query admission are production code.
import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalAgentActivity } from "../../features/agents/local-activity";
import { nativeAgents } from "../../features/agents/native";
import { AgentsService } from "../../features/agents/service";
import {
  bot,
  channel,
  event,
  fakeCommunities,
  fakeRelay,
  viewer,
} from "../../features/agents/service-testing";
import { loadAgentStorage } from "../../features/agents/state";
import { memoryStorage } from "../../features/agents/test-fakes";
import { hasEventProof, type RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import { fakeSpawn } from "./goose-testing";
import type { BuzzEvent } from "../../buzz-mcp/client";
import { apply } from "./index";
import { deferred } from "../builderlab/test-helpers";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("../../features/agents/relay-removal", async (original) => ({
  ...(await original<typeof import("../../features/agents/relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));
const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
const signer = keypair();
const root = signed(signer, {
  kind: 9,
  content: "original",
  tags: [["h", channel]],
});
const reply = signed(signer, {
  kind: 9,
  content: "reply",
  tags: [
    ["h", channel],
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ],
});
const filters = [{ kinds: [9], ids: [root.id], "#h": [channel] }];
const conform = (events: readonly BuzzEvent[]) =>
  expect(events.every((event) => hasEventProof(event as RelayEvent))).toBe(
    true,
  );
const wire = () => JSON.parse(JSON.stringify([root, reply])) as RelayEvent[];

async function setup() {
  vi.mocked(isTauri).mockReturnValue(true);
  localStorage.clear();
  const files = new Map<string, string>();
  const source = {
    query: async (): Promise<unknown> => wire(),
  };
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      const a = args as { key: string; value: string; absent?: boolean };
      switch (command) {
        case "app_agent_list":
          return [
            {
              pubkey: bot,
              owner: viewer,
              relay: "wss://relay.example.test",
              type: "buzz.goose/goose",
              name: "Probe",
              deleted: false,
            },
          ];
        case "app_agent_state_load":
          return Object.fromEntries(
            [...files].filter(([key]) => !a?.key || a.key === key),
          );
        case "app_agent_state_set": {
          const previous = files.get(a.key) ?? null;
          if (!a.absent || previous === null) files.set(a.key, a.value);
          return previous;
        }
        case "app_agent_claim":
          return true;
        case "app_agent_query":
          return source.query();
        case "app_agent_publish": {
          const template = (args as { event: Parameters<typeof signed>[1] })
            .event;
          if (template.kind !== 20002)
            throw new Error("Unexpected side-effect publication");
          return signed(signer, template);
        }
        case "app_agent_publish_profile":
        case "app_agent_release":
        case "keep_awake_set":
          return;
        default:
          throw new Error(`Unexpected native command: ${command}`);
      }
    });
  const storage = await loadAgentStorage(memoryStorage());
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
    settled: () => true,
  });
  const relay = fakeRelay();
  const activity = createLocalAgentActivity();
  const service = new AgentsService(
    ctx,
    fakeCommunities(relay).communities,
    undefined,
    storage,
    undefined,
    activity,
  );

  const fake = fakeSpawn({ hold: true });
  await ctx
    .extend({ pluginOwner: { id: "buzz.goose", revision: "one" } })
    .plugin((scope) => {
      apply({
        ...scope,
        agents: scope.agents,
        host: {
          spawn: fake.spawn,
          resolveDirectory: fake.resolveDirectory,
          readFile: vi.fn(),
          serveMcp: fake.serve,
        },
        agentProtection: { registerModels: vi.fn() },
        effect: scope.effect.bind(scope),
        pluginOwner: scope.pluginOwner,
      } as never);
    })
    .await();
  const effects = { mint: vi.fn(), upload: vi.fn(), prompt: vi.fn() };
  const observed = {
    accepted: 0,
    rejected: 0,
    events: [] as readonly BuzzEvent[],
  };
  const tool = ctx
    .extend({ pluginOwner: { id: "example.probe", revision: "one" } })
    .plugin((scope) => {
      scope.agents.addTool({
        name: "probe_source",
        description: "Read a signed source",
        inputSchema: { type: "object" },
        async call(client, context) {
          expect(context.channel).toBe(channel);
          let events: readonly BuzzEvent[];
          try {
            events = await client.query(filters);
          } catch (error) {
            observed.rejected++;
            throw error;
          }
          observed.accepted++;
          observed.events = events;
          effects.mint();
          effects.upload();
          effects.prompt();
          return "accepted";
        },
      });
    });
  await tool.await();
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  const mention = event("mention", {
    pubkey: viewer,
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  relay.emit({ events: [mention] });
  await vi.waitFor(() => expect(fake.geese[0]?.turns).toHaveLength(1));
  const process = fake.geese[0];
  const turn = process?.turns[0];
  if (!process || !turn) throw new Error("Expected running Goose turn");
  disposals.push(async () => {
    for (const turn of process.turns) turn.finish();
    await vi.waitFor(() =>
      expect(
        activity.reader
          .work()
          .every((work) =>
            ["done", "error", "stopped", "superseded"].includes(work.state),
          ),
      ).toBe(true),
    );
    await ctx.fiber.dispose();
  });
  const call = () =>
    process.mcp(turn.sessionId, "tools/call", {
      name: "probe_source",
      arguments: {},
    });
  return {
    call,
    observed,
    source,
    service,
    effects,
  };
}

it("uses the default native service to re-verify caller-cached false proofs", async () => {
  const f = await setup();
  expect(f.service.snapshot().status).toBe("ready");
  expect(invoke).toHaveBeenCalledWith("app_agent_list");
  const cached = wire().map((event) => ({ ...event, [verifiedSymbol]: false }));
  f.source.query = async () => cached;
  expect(await f.call()).toMatchObject({
    result: { content: [{ text: "accepted" }] },
  });
  expect(f.observed.accepted).toBe(1);
  for (const effect of Object.values(f.effects))
    expect(effect).toHaveBeenCalledOnce();
  expect(f.observed.events.map((e) => e.id)).toEqual([root.id, reply.id]);
  conform(f.observed.events);
  for (const event of cached) expect(event[verifiedSymbol]).toBe(false);
  expect(invoke).toHaveBeenCalledWith("app_agent_query", {
    pubkey: bot,
    relay: "wss://relay.example.test",
    filters,
  });
});

const invalid = [
  ["forged signature", [{ ...root, sig: "0".repeat(128) }]],
  ["changed content", [{ ...root, content: "changed" }]],
  ["changed tags", [{ ...root, tags: [["h", "elsewhere"]] }]],
  ["changed kind", [{ ...root, kind: 7 }]],
  ["malformed tags", [{ ...root, tags: "h" }]],
  ["nonarray", { events: [root] }],
  ["mixed valid/invalid", [root, { ...reply, content: "changed" }]],
  [
    "forged signature despite caller-cached true proof",
    [{ ...root, sig: "0".repeat(128), [verifiedSymbol]: true }],
  ],
] as const;
it.each(invalid)(
  "rejects %s inside the added tool before authority",
  async (_, body) => {
    const f = await setup();
    f.source.query = async () => body;
    const result = await f.call();
    expect(invoke).toHaveBeenCalledWith("app_agent_query", {
      pubkey: bot,
      relay: "wss://relay.example.test",
      filters,
    });
    // These assertions, not just freezing/setup, must fail without eventsDto.
    expect(f.observed.rejected).toBe(1);
    expect(f.observed.accepted).toBe(0);
    expect(JSON.stringify(result)).toMatch(
      /malformed or invalidly signed|not an event array/,
    );
    expect(result).toMatchObject({ result: { isError: true } });
    for (const effect of Object.values(f.effects))
      expect(effect).not.toHaveBeenCalled();
  },
);

it("owns immutable signed wire fields, independent of transport objects", async () => {
  const f = await setup();
  const original = wire();
  f.source.query = async () => original;
  await f.call();
  const sent = original[0];
  const received = f.observed.events[0];
  if (!sent || !received) throw new Error("Expected admitted event");
  (sent.tags[0] as string[])[1] = "changed";
  (sent as { content: string }).content = "changed";
  expect(received).toEqual(root);
  expect(() => {
    (received.tags[0] as string[])[1] = "changed";
  }).toThrow();
  expect(() => {
    (received as { content: string }).content = "changed";
  }).toThrow();
  expect(Object.isFrozen(received.tags)).toBe(true);
});

it.each([false, true])(
  "checks production query lifetime after await (retired=%s)",
  async (retired) => {
    const f = await setup();
    const started = deferred<void>();
    const held = deferred<unknown>();
    f.source.query = () => {
      started.resolve();
      return held.promise;
    };
    const pending = f.call();
    await started.promise;
    try {
      if (retired) {
        const agent = f.service.snapshot().running[0];
        const type = f.service.types().find((type) => type.key === agent?.type);
        if (!agent || !type?.retire)
          throw new Error("Expected live Goose agent");
        await type.retire(agent.key);
      }
    } finally {
      held.resolve(wire());
    }
    const answer = await pending;
    expect(f.observed.rejected).toBe(retired ? 1 : 0);
    expect(f.observed.accepted).toBe(retired ? 0 : 1);
    if (retired) {
      expect(answer).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(answer)).toContain("The Goose agent was retired");
    } else {
      expect(answer).toMatchObject({
        result: { content: [{ text: "accepted" }] },
      });
    }
    for (const effect of Object.values(f.effects))
      expect(effect).toHaveBeenCalledTimes(retired ? 0 : 1);
  },
);

it("does not expose native custody or bundled Goose outside desktop", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeAgents()).toBeUndefined();
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    undefined,
    memoryStorage(),
  );
  expect(service.snapshot().status).toBe("unavailable");
  const register = vi.fn();
  apply({ agents: { register } } as never);
  expect(register).not.toHaveBeenCalled();
  await ctx.fiber.dispose();
});
