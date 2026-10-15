// The launch boundary: a mention goes through the real agents service, its
// runner and the start resolver into each real runtime. The config the
// runtime actually uses comes from confirmed synced copies, the delivery
// carries their revision IDs, and the relay transport underneath sees no
// config request at start, online or offline.
import { Context } from "@deepseek-ai/cordis";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { AgentConfigStore, type Subject } from "./agent-config";
import type { Mode } from "./agent-start";
import { createLocalAgentActivity } from "./local-activity";
import {
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
} from "./service";
import {
  bot,
  channel,
  event,
  fakeCommunities,
  fakeNative,
  fakeRelay,
  viewer,
} from "./service-testing";
import { memoryStorage } from "./test-fakes";
import { type AgentReads, ownerReads } from "./reads";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import type { Wire } from "../../bundled/codex/rpc";
import { gooseRun } from "../../bundled/goose/run";
import { GooseRuntime } from "../../bundled/goose/runtime";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

const key = generateSecretKey();
const base = {
  owner: viewer,
  community: "https://relay.example.test",
  subject: bot,
  channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
};
const settingsSubject: Subject = { ...base, type: "buzz.agent.settings" };
const instructionsSubject: Subject = {
  ...base,
  type: "buzz.agent.instructions",
};
const CLAUDE_LOCAL = {
  model: "local-model",
  effort: "",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread",
};
const CONFIG_KINDS = [45010, 45011, 39000, 39002, 9005];

const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [["op", op]],
    },
    key,
  ) as RelayEvent;

/** Confirmed copies in this device's storage, as a sync read installs them. */
function seed(storage: Storage, heads: [Subject, RelayEvent][]) {
  const store = new AgentConfigStore(storage);
  for (const [subject, head] of heads)
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
}

/** Every call into the relay session, by path, with its arguments. */
function countCalls(target: Record<string, unknown>, path = "") {
  const calls: { path: string; args: unknown[] }[] = [];
  /** While set, every request fails as an unreachable relay's does. */
  const transport = { offline: false };
  const wrap = (object: Record<string, unknown>, prefix: string) => {
    for (const [name, value] of Object.entries(object)) {
      const at = prefix ? `${prefix}.${name}` : name;
      if (typeof value === "function") {
        object[name] = (...args: unknown[]) => {
          calls.push({ path: at, args });
          if (transport.offline && REQUESTS.has(at))
            return Promise.reject(new Error("Relay unreachable"));
          return (value as (...a: unknown[]) => unknown).apply(object, args);
        };
      } else if (value && typeof value === "object" && !Array.isArray(value))
        wrap(value as Record<string, unknown>, at);
    }
  };
  wrap(target, path);
  return { calls, transport };
}

/** Calls that ask the relay for something; reads of local state excluded. */
const REQUESTS = new Set([
  "read",
  "snapshotRead",
  "agentMemories.read",
  "profiles.ensure",
  "mePlacement.refresh",
]);
const configRequests = (calls: { path: string; args: unknown[] }[]) =>
  calls
    .filter((call) => REQUESTS.has(call.path))
    .filter((call) =>
      JSON.stringify(call.args).match(
        new RegExp(`"kinds":\\[[^\\]]*\\b(${CONFIG_KINDS.join("|")})\\b`),
      ),
    );

async function setup<Config>(
  typeId: string,
  runs: (
    relay: (pubkey: string) => RelayData | undefined,
    reads: (pubkey: string) => AgentReads | undefined,
    core: AgentsService["core"],
  ) => Pick<
    AgentType<Config>,
    "run" | "runOnce" | "timeoutMs" | "syncedSettings"
  >,
  defaults: Config,
  heads: [Subject, RelayEvent][],
  binding: ConfigBinding,
) {
  const storage = memoryStorage();
  seed(storage, heads);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const fake = fakeRelay();
  Object.assign(fake.session, {
    snapshotRead: vi.fn(async () => []),
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => new Map(),
      event: () => undefined,
    },
    names: { resolve: () => undefined },
  });
  const { calls, transport } = countCalls(
    fake.session as unknown as Record<string, unknown>,
  );
  const client = fakeCommunities(fake);
  const native = fakeNative();
  const activity = createLocalAgentActivity();
  const service = new AgentsService(
    ctx,
    client.communities,
    native,
    storage,
    async () => ["auth", viewer, "", "f".repeat(128)] as const,
    activity,
    undefined,
    () => binding,
  );
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "buzz", revision: "one" }),
  });
  const deliveries: Delivery<Config>[] = [];
  const real = runs(
    (pubkey) => service.relay(pubkey),
    (pubkey) => ownerReads(service.relay(pubkey), pubkey),
    (pubkey, signal) => service.core(pubkey, signal),
  );
  plugin.agents.register<Config>({
    id: typeId,
    title: typeId,
    defaults: () => ({ config: defaults }),
    ...real,
    run: (delivery) => {
      deliveries.push(delivery);
      return real.run?.(delivery);
    },
  });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  await service.create({ type: `buzz/${typeId}`, name: typeId });
  let id = 0;
  /** A new top-level mention from the owner: a new conversation. */
  const mention = () => {
    const sent = event(`m${++id}`, {
      pubkey: viewer,
      content: "@agent hello",
      tags: [
        ["h", channel],
        ["p", bot],
      ],
    });
    fake.emit({ events: [sent], channelId: channel });
    return sent;
  };
  return { service, fake, calls, transport, deliveries, activity, mention };
}

const synced = (mode: Mode = "synced") => ({
  settings: { mode, subject: settingsSubject },
  instructions: { mode, subject: instructionsSubject },
});

afterEach(() => vi.restoreAllMocks());

// Listing the agent in its community is not under test here.
vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

/** Synced copies for `agentType`: these settings, and instructions. */
function heads(agentType: string, settings: Record<string, string>) {
  const s = revision({ agentType, settings });
  const i = revision({ text: "SYNCED INSTRUCTIONS" });
  return {
    revisions: [s.id, i.id],
    seeded: [
      [settingsSubject, s],
      [instructionsSubject, i],
    ] as [Subject, RelayEvent][],
  };
}

/** The counter sees a config sync read when one is made: it counts. */
async function expectCounterSeesSync(f: Awaited<ReturnType<typeof setup>>) {
  f.transport.offline = false;
  const before = configRequests(f.calls).length;
  await (
    f.fake.session as unknown as {
      snapshotRead(filters: object[]): Promise<unknown>;
    }
  ).snapshotRead([{ kinds: [45010], "#h": [base.channel], limit: 1 }]);
  expect(configRequests(f.calls)).toHaveLength(before + 1);
}

it("starts Claude sessions from the synced copies, with no config request online or offline", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { revisions, seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  const f = await setup(
    "claude-code",
    (_relay, reads, core) =>
      claudeRun(new ClaudeRuntime(host, reads, core, memoryStorage())),
    { ...CLAUDE_LOCAL },
    seeded,
    synced(),
  );
  f.calls.length = 0;
  f.mention();
  await vi.waitFor(() => expect(claude.processes).toHaveLength(1));
  const [first] = claude.processes;
  expect(first?.model).toBe("synced-model");
  expect(first?.options.cwd).toBe("/this/device");
  await vi.waitFor(() =>
    expect(JSON.stringify(first?.received)).toContain("SYNCED INSTRUCTIONS"),
  );
  expect(JSON.stringify(first?.received)).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);

  // The relay goes away; the next conversation starts from the same copies.
  f.transport.offline = true;
  f.calls.length = 0;
  f.mention();
  await vi.waitFor(() => expect(claude.processes).toHaveLength(2));
  expect(claude.processes[1]?.model).toBe("synced-model");
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);
  await expectCounterSeesSync(f);
});

/** A Codex app server that answers what a thread and a turn need. */
function fakeCodex() {
  const sent: Wire[] = [];
  let options: HostProcessOptions | undefined;
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id == null || !request.method) return;
      const params = request.params as Record<string, unknown>;
      const result =
        request.method === "thread/start"
          ? { thread: { id: `thread-${sent.length}`, cwd: params.cwd } }
          : request.method === "turn/start"
            ? { turn: { id: `turn-${sent.length}` } }
            : request.method === "model/list"
              ? {
                  data: ["local-model", "synced-model"].map((model) => ({
                    model,
                    displayName: model,
                    isDefault: model === "local-model",
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: ["low", "high"].map(
                      (reasoningEffort) => ({
                        reasoningEffort,
                        description: "",
                      }),
                    ),
                  })),
                  nextCursor: null,
                }
              : request.method === "config/read"
                ? { config: {} }
                : {};
      emit({ id: request.id, result });
      // Each turn finishes at once, so the next conversation can start.
      if (request.method === "turn/start")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { ...(result as { turn: object }).turn, status: "completed" },
          },
        });
    },
    end: async () => {},
    kill: async () => {},
    exited: new Promise<number | null>(() => {}),
  };
  const spawn = async (id: string, value?: HostProcessOptions) => {
    if (id === "workspace") {
      value?.onStdout?.(`${value.cwd ?? ""}\n`);
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  };
  return { spawn, sent };
}

it("starts a Codex thread and a turn from the synced copies, with no config request online or offline", async () => {
  const codex = fakeCodex();
  const { revisions, seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "thread",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const starts = (method: string) =>
    codex.sent.filter((wire) => wire.method === method);
  f.calls.length = 0;
  f.mention();
  await vi.waitFor(() => expect(starts("turn/start")).toHaveLength(1));
  const [thread] = starts("thread/start");
  expect(thread?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  const sentToCodex = JSON.stringify(codex.sent);
  expect(sentToCodex).toContain("SYNCED INSTRUCTIONS");
  expect(sentToCodex).not.toContain("LOCAL INSTRUCTIONS");
  expect(starts("turn/start")[0]?.params).toMatchObject({ effort: "high" });
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);

  f.transport.offline = true;
  f.calls.length = 0;
  f.mention();
  // The thread still opens from the copies; its turn then needs the
  // conversation itself, which an unreachable relay cannot give.
  await vi.waitFor(() => expect(starts("thread/start")).toHaveLength(2));
  expect(starts("thread/start")[1]?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);
  await expectCounterSeesSync(f);
});

const GOOSE_LOCAL = {
  model: "local-model",
  provider: "local-provider",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread" as const,
};

function gooseHost() {
  const goose = fakeGoose({
    providers: [
      { providerId: "synced-provider", models: [{ modelId: "synced-model" }] },
    ],
    supported: ["synced-model"],
  });
  const host = { spawn: goose.spawn, serveMcp: goose.serve } as unknown as Host;
  return { goose, host };
}

it("starts Goose sessions from the synced copies, with no config request online or offline", async () => {
  const { goose, host } = gooseHost();
  const { revisions, seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  f.calls.length = 0;
  f.mention();
  const process = () => goose.geese[0];
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(1));
  const used = () => JSON.stringify([process()?.opened, process()?.configured]);
  expect(used()).toContain("synced-model");
  expect(used()).toContain("synced-provider");
  expect(used()).not.toContain("local-model");
  expect(process()?.opened[0]).toMatchObject({ cwd: "/this/device" });
  const prompts = JSON.stringify([...(process()?.prompts.values() ?? [])]);
  expect(prompts).toContain("SYNCED INSTRUCTIONS");
  expect(prompts).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);

  f.transport.offline = true;
  f.calls.length = 0;
  f.mention();
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(2));
  expect(process()?.opened).toHaveLength(2);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expect(configRequests(f.calls)).toEqual([]);
  await expectCounterSeesSync(f);
});

it("refuses to start from deleted synced settings: no launch, the reason on the mention, no retry", async () => {
  const { goose, host } = gooseHost();
  const deleted = revision(null, "delete");
  const { seeded } = heads("buzz/goose", { model: "synced-model" });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    [[settingsSubject, deleted], seeded[1] as [Subject, RelayEvent]],
    synced(),
  );
  f.calls.length = 0;
  const sent = f.mention();
  await vi.waitFor(() =>
    expect(JSON.stringify(f.activity.reader.work())).toContain(
      "restore from History",
    ),
  );
  expect(JSON.stringify(f.activity.reader.work())).toContain(sent.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(f.deliveries).toEqual([]);
  expect(goose.geese).toEqual([]);
  expect(configRequests(f.calls)).toEqual([]);
});
