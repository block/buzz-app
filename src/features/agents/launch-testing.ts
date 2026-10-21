// The launch-boundary fixture: the real agents service, runner and start
// resolver over a counted relay session, with each real runtime registered
// through its plugin wiring.
import { Context } from "@deepseek-ai/cordis";
import { finalizeEvent } from "nostr-tools";
import { expect, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, profile, roster } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, readHead } from "./agent-config-artifacts";
import type { Mode } from "./agent-start";
import type { AgentStore } from "./store";
import { createLocalAgentActivity } from "./local-activity";
import { type AgentReads, ownerReads } from "./reads";
import {
  type AgentCommunities,
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
} from "./service";
import { fakeNative } from "./service-testing";
import { memoryStorage } from "./test-fakes";
import type { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import type { CodexRuntime } from "../../bundled/codex/runtime";
import type { Wire } from "../../bundled/codex/rpc";
import type { GooseRuntime } from "../../bundled/goose/runtime";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

/** Run after each test, newest first. */
export const disposals: (() => unknown)[] = [];

export const owner = keypair();
export const relayKey = keypair();
export const agentKey = keypair();
export const artifactKey = keypair();
export const origin = "https://relay.example.test";
export const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
export const configChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
export const base = {
  owner: owner.pubkey,
  community: origin,
  subject: agentKey.pubkey,
  channel: configChannel,
};
export const settingsSubject: Subject = {
  ...base,
  type: "buzz.agent.settings",
};
export const instructionsSubject: Subject = {
  ...base,
  type: "buzz.agent.instructions",
};

export const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [
        ["op", op],
        ["h", configChannel],
      ],
    },
    artifactKey.secret,
  ) as RelayEvent;

/** Confirmed copies in this device's storage, as a sync read installs them. */
export function seed(storage: AgentStore, heads: [Subject, RelayEvent][]) {
  const store = new AgentConfigStore(storage);
  for (const [subject, head] of heads)
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
}

/** One request the transport saw: a read's filters, or an encrypted memory
 * listing (a request of its own, never a config read). */
export type Request = {
  filters: readonly ReadFilter[];
  memory?: { agent: string; slug: string | undefined };
  failed: boolean;
  /** Whether every mention sent so far had finished when it was made. */
  afterRuns: boolean;
};

/** The one read a Codex turn makes of its conversation (§4.3): the mention
 * and its thread's replies, messages and their edits, in its channel, up to
 * the mention. */
export const conversationRead = (sent: RelayEvent): readonly ReadFilter[] => {
  const window = { kinds: [40002, 9], "#h": [channel], until: sent.created_at };
  return [
    { ...window, ids: [sent.id], limit: 1 },
    { ...window, "#e": [sent.id], limit: 50 },
  ];
};

/** A transport that answers from `records`, recording every request it sees.
 * While `offline`, every request fails as an unreachable relay's does. */
export function countedTransport(records: RelayEvent[]) {
  const requests: Request[] = [];
  const state = { offline: false, afterRuns: () => false };
  let live!: LiveCallbacks;
  const transport = {
    viewer: owner.pubkey,
    relayAuthor: relayKey.pubkey,
    scope: origin,
    media: () => undefined,
    async query(filters: readonly ReadFilter[]) {
      const request = {
        filters,
        failed: state.offline,
        afterRuns: state.afterRuns(),
      };
      requests.push(request);
      if (state.offline) throw new Error("Relay unreachable");
      return records.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
    async readAgentMemories(agent: string, _: AbortSignal, slug?: string) {
      requests.push({
        filters: [],
        memory: { agent, slug },
        failed: state.offline,
        afterRuns: state.afterRuns(),
      });
      if (state.offline) throw new Error("Relay unreachable");
      return { entries: [], partial: false };
    },
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  };
  return { transport, requests, state, live: () => live };
}

export async function setup<Config>(
  typeId: string,
  runs: (
    relay: (pubkey: string) => RelayData | undefined,
    reads: (pubkey: string) => AgentReads | undefined,
    core: AgentsService["core"],
  ) => Pick<
    AgentType<Config>,
    | "run"
    | "runOnce"
    | "timeoutMs"
    | "syncedSettings"
    | "restart"
    | "models"
    | "defaultsChanged"
  >,
  defaults: Config,
  heads: [Subject, RelayEvent][],
  binding: ConfigBinding,
) {
  const storage = memoryStorage();
  seed(storage, heads);
  const counted = countedTransport([
    metadata(relayKey, channel, "general"),
    roster(relayKey, channel, [owner.pubkey, agentKey.pubkey]),
    profile(owner, { name: "Owner" }),
    profile(agentKey, { name: typeId, is_agent: true }),
    ...heads.map(([, head]) => head),
  ]);
  const session = createRelaySession(counted.transport);
  disposals.push(() => session.dispose());
  const relayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: session.session,
      scope: `${origin}:${owner.pubkey}`,
      origin,
      viewer: owner.pubkey,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => ({
      viewer: owner.pubkey,
      selected: origin,
      memberships: [{ id: origin, name: "Test" }],
    }),
    subscribe: () => () => {},
    open: () => relayData,
  } as unknown as AgentCommunities;
  const native = fakeNative([
    {
      pubkey: agentKey.pubkey,
      name: typeId,
      owner: owner.pubkey,
      relay: "wss://relay.example.test",
      type: `buzz/${typeId}`,
      deleted: false,
    },
  ]);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const activity = createLocalAgentActivity();
  /** Each start's binding lookup: one per start attempt. */
  const attempts = vi.fn(() => binding);
  const service = new AgentsService(
    ctx,
    communities,
    native,
    storage,
    undefined,
    activity,
    undefined,
    attempts,
  );
  disposals.push(() => ctx.fiber.dispose());
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
  // Settle every cache a start may consult before counting begins.
  session.session.channels.ensureList();
  counted.live().state({ status: "connected", routes: [] });
  await vi.waitFor(() =>
    expect(service.snapshot().agents.map((agent) => agent.pubkey)).toContain(
      agentKey.pubkey,
    ),
  );
  // Discovery lists the channel only once it has applied its access change,
  // which would cancel reads still in flight.
  await vi.waitFor(() =>
    expect(session.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [expect.objectContaining({ id: channel })],
    }),
  );
  await session.session.profiles.ensure([owner.pubkey, agentKey.pubkey]);
  await service.core(agentKey.pubkey);
  counted.requests.length = 0;
  let at = Math.floor(Date.now() / 1000);
  let mentions = 0;
  counted.state.afterRuns = () =>
    activity.reader
      .work()
      .filter((work) => !["waiting", "working"].includes(work.state)).length ===
    mentions;
  /** A new top-level mention from the owner: a new conversation. */
  const mention = (tags: string[][] = []) => {
    mentions++;
    const sent = message(owner, channel, "@agent hello", ++at, [
      ["p", agentKey.pubkey],
      ...tags,
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  /** A reply from the owner in `root`'s thread: the same conversation. */
  const reply = (root: RelayEvent, tags: string[][] = []) => {
    mentions++;
    const sent = message(owner, channel, "@agent again", ++at, [
      ["e", root.id, "", "reply"],
      ["p", agentKey.pubkey],
      ...tags,
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  return {
    service,
    session: session.session,
    requests: counted.requests,
    transport: counted.state,
    deliveries,
    activity,
    attempts,
    mention,
    reply,
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;

/** The runner's refresh of the agent's `core` memory once its work has
 * ended, for a later start that never waits on it (`runner.ts` `release`). */
export const postRunCoreRefresh = (request: Request) =>
  request.afterRuns &&
  request.memory?.agent === agentKey.pubkey &&
  request.memory.slug === "core";

/** Apart from the post-run core refresh, the recorded requests are exactly
 * one conversation read for each of `conversations`, in order: an extra, a
 * wider or a different read fails. */
export function expectOnlyAllowed(
  f: Fixture,
  conversations: readonly RelayEvent[] = [],
) {
  expect(
    f.requests
      .filter((request) => !postRunCoreRefresh(request))
      .map((request) => request.filters),
  ).toEqual(conversations.map(conversationRead));
}

export const synced = (mode: Mode = "synced") => ({
  settings: { mode, subject: settingsSubject },
  instructions: { mode, subject: instructionsSubject },
});

/** Synced copies for `agentType`: these settings, and instructions. */
export function heads(agentType: string, settings: Record<string, string>) {
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

/** The same counter records a real config sync read once the relay is back. */
export async function expectCounterSeesSync(f: Fixture) {
  f.transport.offline = false;
  f.requests.length = 0;
  const read = f.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  await readHead(
    read,
    configChannel,
    await artifactD("buzz.agent.settings", configChannel),
  );
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.filters[0]).toMatchObject({
    kinds: [45010],
    "#h": [configChannel],
  });
}

/** Wires `runtime` to the service as its plugin does (`index.ts`): it sees
 * the agent's local config now and after every change, before any delivery
 * carries the synced one. Returns the sync, for a test to run after an edit. */
export function plugged(
  f: Fixture,
  runtime: Pick<ClaudeRuntime | GooseRuntime | CodexRuntime, "sync">,
) {
  const sync = () =>
    runtime.sync(
      f.service
        .snapshot()
        .running.filter((agent) => agent.pubkey === agentKey.pubkey),
    );
  disposals.push(f.service.subscribe(sync));
  sync();
  return sync;
}

/** Another device edits the synced settings: a new confirmed head arrives. */
export function remoteEdit(
  f: Fixture,
  agentType: string,
  settings: Record<string, string>,
) {
  const store = (f.service as unknown as { configStore: AgentConfigStore })
    .configStore;
  store.applyRead(settingsSubject, store.capture(settingsSubject), {
    kind: "head",
    event: revision({ agentType, settings }),
  });
}

/** A Codex app server that answers what a thread and a turn need. */
export function fakeCodex() {
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
        request.method === "thread/start" || request.method === "thread/resume"
          ? {
              thread: {
                id: params.threadId ?? `thread-${sent.length}`,
                cwd: params.cwd,
              },
            }
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

export const GOOSE_LOCAL = {
  model: "local-model",
  provider: "local-provider",
  effort: "",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread" as const,
};

export function gooseHost() {
  const goose = fakeGoose({
    providers: [
      { providerId: "synced-provider", models: [{ modelId: "synced-model" }] },
    ],
    supported: ["synced-model"],
  });
  const host = {
    spawn: goose.spawn,
    resolveDirectory: goose.resolveDirectory,
    readFile: vi.fn(),
    serveMcp: goose.serve,
  } as unknown as Host;
  return { goose, host };
}
