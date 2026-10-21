import { afterEach, expect, it, vi } from "vitest";
import type { Host } from "../host/service";
import type { RelayEvent } from "../relay/events";
import type { AgentConfigStore, Subject } from "./agent-config";
import type { Delivery } from "./service";
import { memoryStorage } from "./test-fakes";
import {
  disposals,
  agentKey,
  settingsSubject,
  instructionsSubject,
  revision,
  setup,
  type Fixture,
  postRunCoreRefresh,
  expectOnlyAllowed,
  synced,
  heads,
  expectCounterSeesSync,
  plugged,
  remoteEdit,
  fakeCodex,
  GOOSE_LOCAL,
  gooseHost,
} from "./launch-testing";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { AgentSessions as ClaudeSessions } from "../../bundled/claude-code/sessions";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import { gooseRun } from "../../bundled/goose/run";
import { GooseRuntime } from "../../bundled/goose/runtime";

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Listing the agent in its community is not under test here.
vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

it("starts Claude sessions from the synced copies, with no relay request online or offline", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { revisions, seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  // The local sync warms spare processes on the local row; only the ones a
  // delivery prompted count.
  const used = () =>
    claude.processes.filter((process) => process.prompts.length);
  const prompted = (index: number) =>
    vi.waitFor(() =>
      expect(JSON.stringify(used()[index]?.received)).toContain(
        "SYNCED INSTRUCTIONS",
      ),
    );
  f.mention();
  await prompted(0);
  const [first] = used();
  expect(first?.model).toBe("synced-model");
  expect(first?.options.cwd).toBe("/this/device");
  expect(JSON.stringify(first?.received)).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.attempt.settings.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  // The relay goes away; the next conversation starts from the same copies.
  f.transport.offline = true;
  f.mention();
  await prompted(1);
  expect(used()[1]?.model).toBe("synced-model");
  expect(JSON.stringify(used()[1]?.received)).not.toContain(
    "LOCAL INSTRUCTIONS",
  );
  expect(f.deliveries[1]?.attempt.settings.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("keeps a running Claude conversation on its config after a synced edit until Restart to apply, and starts new ones on the edit", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const sync = plugged(f, runtime);
  /** Whether a conversation runs on config other than the current synced
   * copy, which the last delivery carried. */
  const outdated = () =>
    runtime.outdated(
      agentKey.pubkey,
      (f.deliveries.at(-1) as Delivery).attempt.settings,
    );
  /** The processes that took a prompt, not the spare one waiting. */
  const used = () =>
    claude.processes.filter((process) => process.prompts.length);
  const prompts = () =>
    used().map((process) => [process.model, process.prompts.length]);

  const root = f.mention();
  await vi.waitFor(() => expect(prompts()).toEqual([["synced-model", 1]]));

  remoteEdit(f, "buzz/claude-code", { model: "edited-model", scope: "thread" });
  sync();
  const reply = () => f.reply(root);
  reply();
  await vi.waitFor(() => expect(prompts()).toEqual([["synced-model", 2]]));
  expect(used()[0]?.killed).toBe(false);
  expect(outdated()).toBe(true);

  // A new conversation starts on the edit.
  f.mention();
  await vi.waitFor(() =>
    expect(prompts()).toEqual([
      ["synced-model", 2],
      ["edited-model", 1],
    ]),
  );
  expect(outdated()).toBe(true);

  // Restart to apply moves the first conversation onto the edit.
  f.service.restart(agentKey.pubkey);
  reply();
  await vi.waitFor(() =>
    expect(prompts()).toEqual([
      ["synced-model", 2],
      ["edited-model", 1],
      ["edited-model", 1],
    ]),
  );
  expect(used()[0]?.killed).toBe(true);
  expect(outdated()).toBe(false);
});

it("starts a Codex thread and a turn from the synced copies; offline, only its conversation reads fail", async () => {
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
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  const [thread] = starts("thread/start");
  expect(thread?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  const sentToCodex = JSON.stringify(codex.sent);
  expect(sentToCodex).toContain("SYNCED INSTRUCTIONS");
  expect(sentToCodex).not.toContain("LOCAL INSTRUCTIONS");
  expect(starts("turn/start")).toHaveLength(1);
  expect(starts("turn/start")[0]?.params).toMatchObject({ effort: "high" });
  expect(f.deliveries[0]?.attempt.settings.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [first]);

  // Offline until the second mention ends: the thread still opens from the
  // copies, and the turn fails on its conversation reads alone (§4.3).
  f.transport.offline = true;
  f.requests.length = 0;
  const second = f.mention();
  await vi.waitFor(() => expect(outcome(second.id)?.state).toBe("error"));
  expect(outcome(second.id)?.error).toBe("Relay unreachable");
  expect(starts("thread/start")).toHaveLength(2);
  expect(starts("thread/start")[1]?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  expect(starts("turn/start")).toHaveLength(1);
  expect(f.deliveries[1]?.attempt.settings.revisions).toEqual(revisions);
  // Until the run ended, the turn's conversation read was all it asked, and
  // it failed.
  expectOnlyAllowed(f, [second]);
  expect(
    f.requests.filter((request) => !postRunCoreRefresh(request)),
  ).toMatchObject([{ failed: true }]);
  await expectCounterSeesSync(f);
});

it("starts Goose sessions from the synced copies, with no relay request online or offline", async () => {
  const { goose, host } = gooseHost();
  const { revisions, seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  let runtime!: GooseRuntime;
  const f = await setup(
    "goose",
    (relay, _reads, core) => {
      runtime = new GooseRuntime(host, relay, core);
      return gooseRun(runtime);
    },
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  f.mention();
  const process = () => goose.geese[0];
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(1));
  const used = () => JSON.stringify([process()?.opened, process()?.configured]);
  expect(used()).toContain("synced-model");
  expect(used()).toContain("synced-provider");
  expect(used()).not.toContain("local-model");
  expect(process()?.opened[0]).toMatchObject({ cwd: "/this/device" });
  const prompts = () =>
    JSON.stringify([...(process()?.prompts.values() ?? [])]);
  expect(prompts()).toContain("SYNCED INSTRUCTIONS");
  expect(prompts()).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.attempt.settings.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  f.transport.offline = true;
  f.mention();
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(2));
  expect(process()?.opened).toHaveLength(2);
  expect(f.deliveries[1]?.attempt.settings.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("keeps a running Goose conversation on its config after a synced edit until Restart to apply, and starts new ones on the edit", async () => {
  const { goose, host } = gooseHost();
  const { seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  let runtime!: GooseRuntime;
  const f = await setup(
    "goose",
    (relay, _reads, core) => {
      runtime = new GooseRuntime(host, relay, core);
      return gooseRun(runtime);
    },
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  const sync = plugged(f, runtime);
  const outdated = () =>
    runtime.outdated(
      agentKey.pubkey,
      (f.deliveries.at(-1) as Delivery).attempt.settings,
    );
  const process = () => goose.geese[0];
  /** Each turn's session, and the models set on each session. */
  const turns = () => process()?.turns.map((turn) => turn.sessionId);
  const models = () =>
    process()?.configured.filter((line) => line.includes("model="));

  const root = f.mention();
  await vi.waitFor(() => expect(turns()).toEqual(["session-1"]));
  expect(models()).toEqual(["session-1 model=synced-model"]);

  remoteEdit(f, "buzz/goose", {
    model: "edited-model",
    provider: "synced-provider",
    scope: "thread",
  });
  sync();
  const reply = () => f.reply(root);
  reply();
  await vi.waitFor(() => expect(turns()).toEqual(["session-1", "session-1"]));
  expect(process()?.closed).toEqual([]);
  expect(models()).toEqual(["session-1 model=synced-model"]);
  expect(outdated()).toBe(true);

  // A new conversation opens on the edit.
  f.mention();
  await vi.waitFor(() => expect(turns()).toHaveLength(3));
  expect(models()).toEqual([
    "session-1 model=synced-model",
    "session-2 model=edited-model",
  ]);
  expect(outdated()).toBe(true);

  // Restart to apply moves the first conversation onto the edit.
  f.service.restart(agentKey.pubkey);
  await vi.waitFor(() => expect(process()?.closed).toContain("session-1"));
  expect(outdated()).toBe(false);
  reply();
  await vi.waitFor(() => expect(turns()).toHaveLength(4));
  expect(models()?.at(-1)).toBe("session-3 model=edited-model");
});

it("refuses to start from deleted synced settings once: no launch, the reason on the mention, no retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  f.attempts.mockClear();
  const sent = f.mention();
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toEqual([
    expect.objectContaining({
      state: "error",
      error: "Settings were deleted — restore from History",
    }),
  ]);
  // Past the service's next tick, which runs whatever is still queued.
  await vi.advanceTimersByTimeAsync(6_000);
  expect(f.attempts).toHaveBeenCalledTimes(1);
  expect(work()).toHaveLength(1);
  // Goose syncs settings, so its handoff refuses them, before any launch.
  expect(f.deliveries).toHaveLength(1);
  expect(goose.geese).toEqual([]);
  expectOnlyAllowed(f);
});

/** The mention's single outcome, once its work has ended. */
async function refused(f: Fixture, sent: RelayEvent) {
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toHaveLength(1);
  return work()[0]?.error;
}

it("refuses a Codex start whose synced effort its model lacks, rather than run at the default", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
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
  const error = await refused(f, f.mention());
  expect(error).toBe(
    'The synced effort "xhigh" isn\'t available for synced-model. Choose a supported effort in Settings.',
  );
  expect(codex.sent.filter((wire) => wire.method === "turn/start")).toEqual([]);
});

/** A Claude agent whose local row runs `local` and whose synced settings run
 * `model` at `effort`, synced into the runtime from the local row first, as
 * the plugin does before any delivery. */
async function claudeSynced(local: string, model: string, effort: string) {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { seeded } = heads("buzz/claude-code", {
    model,
    effort,
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: local,
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  // Which instructions a running entry gets is option A's to settle; this
  // is only whether a turn was handed to Claude at all.
  const prompted = () =>
    claude.processes.some((p) =>
      JSON.stringify(p.received).includes("@agent hello"),
    );
  return { f, prompted };
}

it("starts a Claude turn whose synced effort only the synced model offers", async () => {
  const { f, prompted } = await claudeSynced("haiku", "opus", "xhigh");
  f.mention();
  await vi.waitFor(() => expect(prompted()).toBe(true));
});

it("refuses a Claude start whose synced effort the synced model lacks, though the local model has it", async () => {
  const { f, prompted } = await claudeSynced("opus", "haiku", "xhigh");
  expect(await refused(f, f.mention())).toBe(
    'The synced effort "xhigh" isn\'t available for Haiku 5.5. Choose a supported effort in Settings.',
  );
  expect(prompted()).toBe(false);
});

it("refuses a synced Claude effort it can't check when Claude lists no models", async () => {
  vi.spyOn(ClaudeSessions.prototype, "metadata").mockResolvedValue({
    models: [],
    model: undefined,
    effort: undefined,
  });
  const { f, prompted } = await claudeSynced("opus", "opus", "high");
  expect(await refused(f, f.mention())).toBe(
    "The synced effort \"high\" couldn't be checked: Claude doesn't list the model opus.",
  );
  expect(prompted()).toBe(false);
});

it("refuses a pinned synced effort after a supported first-turn composer override", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
    scope: "thread",
  });
  let runtime!: CodexRuntime;
  const f = await setup(
    "codex",
    (_relay, reads, core) => {
      runtime = new CodexRuntime(codex.spawn, reads, core, memoryStorage());
      disposals.push(() => runtime.dispose());
      return codexRun(runtime);
    },
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
  plugged(f, runtime);
  const turns = () => codex.sent.filter((wire) => wire.method === "turn/start");
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention([
    ["model", agentKey.pubkey, "local-model"],
    ["effort", agentKey.pubkey, "high"],
  ]);
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  expect(f.deliveries[0]).toMatchObject({
    model: "local-model",
    effort: "high",
    attempt: {
      settings: {
        synced: { effort: "xhigh" },
        config: { model: "synced-model", effort: "xhigh" },
      },
    },
  });
  expect(turns()).toHaveLength(1);
  expect(turns()[0]?.params).toMatchObject({
    model: "local-model",
    effort: "high",
  });
  const next = f.reply(first);
  await vi.waitFor(() =>
    expect(["done", "error"]).toContain(outcome(next.id)?.state),
  );
  expect(f.deliveries[1]?.model).toBeUndefined();
  expect(f.deliveries[1]?.effort).toBeUndefined();
  expect({
    state: outcome(next.id)?.state,
    error: outcome(next.id)?.error,
    turns: turns().map((wire) => {
      const { model, effort } = wire.params as {
        model: string;
        effort: string;
      };
      return { model, effort };
    }),
  }).toEqual({
    state: "error",
    error:
      'The synced effort "xhigh" isn\'t available for synced-model. Choose a supported effort in Settings.',
    turns: [{ model: "local-model", effort: "high" }],
  });
});

it("keeps a valid Codex pin's effort after an unsupported remote edit", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "local-model",
    effort: "high",
    scope: "thread",
  });
  let runtime!: CodexRuntime;
  const f = await setup(
    "codex",
    (_relay, reads, core) => {
      runtime = new CodexRuntime(codex.spawn, reads, core, memoryStorage());
      disposals.push(() => runtime.dispose());
      return codexRun(runtime);
    },
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
  const sync = plugged(f, runtime);
  const turns = () => codex.sent.filter((wire) => wire.method === "turn/start");
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  remoteEdit(f, "buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
    scope: "thread",
  });
  sync();
  const next = f.reply(first);
  await vi.waitFor(() => expect(outcome(next.id)?.state).toBe("done"));
  expect(f.deliveries[1]).toMatchObject({
    attempt: {
      settings: {
        synced: { effort: "xhigh" },
        config: { model: "synced-model", effort: "xhigh" },
      },
    },
  });
  expect(turns()).toHaveLength(2);
  expect(turns()[1]?.params).toMatchObject({
    model: "local-model",
    effort: "high",
  });
});

it("refuses a Claude recovery after a local save while its synced instructions are deleted, until they're restored", async () => {
  const claude = fakeClaude();
  // A resume waits here while held: the turn is admitted and under way.
  let hold: Promise<void> | undefined;
  let held = false;
  const spawn: typeof claude.spawn = async (id, options) => {
    if (hold && options?.args?.includes("--resume")) {
      held = true;
      await hold;
    }
    return claude.spawn(id, options);
  };
  const host = { spawn, request: vi.fn() } as unknown as Host;
  const storage = memoryStorage();
  const { seeded } = heads("buzz/claude-code", {
    model: "opus",
    effort: "xhigh",
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const local = {
    model: "opus",
    effort: "",
    instructions: "LOCAL INSTRUCTIONS",
    workspace: "/this/device",
    scope: "thread",
  };
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, storage);
      return claudeRun(runtime);
    },
    local,
    seeded,
    synced(),
  );
  // The agent's community binds its config here, as config sync does; that
  // binding is what the editor resolves its row against.
  const internals = f.service as unknown as {
    syncedBinding: () => unknown;
    communityConfigs: Map<string, unknown>;
  };
  vi.spyOn(internals, "syncedBinding").mockReturnValue(synced());
  vi.spyOn(internals.communityConfigs, "has").mockReturnValue(true);
  plugged(f, runtime);
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  // Its process ends, and Claude no longer has its saved session.
  for (const process of claude.processes) process.exit(0);
  const sessionsKey = "buzz.claude-code.sessions.v1";
  const saved = JSON.parse(storage.getItem(sessionsKey) ?? "{}");
  for (const sessions of Object.values(saved) as Record<
    string,
    { id: string }
  >[])
    for (const session of Object.values(sessions)) session.id = "lost";
  storage.setItem(sessionsKey, JSON.stringify(saved));
  let release!: () => void;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  const next = f.reply(first);
  await vi.waitFor(() => expect(held).toBe(true));
  // The synced instructions are deleted, then this device saves Haiku/xhigh.
  const store = (f.service as unknown as { configStore: AgentConfigStore })
    .configStore;
  const instructions = store.state(instructionsSubject).head;
  store.applyRead(instructionsSubject, store.capture(instructionsSubject), {
    kind: "head",
    event: revision(null, "delete"),
  });
  void f.service
    .save(agentKey.pubkey, {
      config: { ...local, model: "haiku", effort: "xhigh", workspace: "/new" },
    })
    .catch(() => undefined);
  await vi.waitFor(() =>
    expect(
      f.service.snapshot().running.find((a) => a.pubkey === agentKey.pubkey)
        ?.blocked,
    ).toBe("Instructions were deleted — restore from History"),
  );
  release();
  await vi.waitFor(() => expect(outcome(next.id)?.state).toBe("error"));
  expect(outcome(next.id)?.error).toBe(
    "Instructions were deleted — restore from History",
  );
  const haiku = () =>
    claude.processes.filter(
      (p) => p.options.args?.includes("haiku") && p.prompts.length,
    );
  expect(haiku()).toEqual([]);
  // Restored: a later turn runs.
  if (!instructions) throw new Error("no instructions head");
  store.applyRead(instructionsSubject, store.capture(instructionsSubject), {
    kind: "head",
    event: instructions,
  });
  const later = f.mention();
  await vi.waitFor(() => expect(outcome(later.id)?.state).toBe("done"));
});

it("publishes a new synced resolution while the local row stays the same object", async () => {
  const { f } = await claudeSynced("opus", "opus", "high");
  const internals = f.service as unknown as {
    syncedBinding: () => unknown;
    update: () => void;
    configStore: AgentConfigStore;
  };
  // The view and a start resolve from one binding lookup, as the host
  // makes it: local first.
  const syncedBinding = vi
    .spyOn(internals, "syncedBinding")
    .mockReturnValue(undefined);
  f.attempts.mockReturnValue({});
  const binding = {
    mockReturnValue(next: ReturnType<typeof synced>) {
      syncedBinding.mockReturnValue(next);
      f.attempts.mockReturnValue(next);
    },
  };
  const update = () => internals.update();
  const view = () =>
    f.service.snapshot().running.find((a) => a.pubkey === agentKey.pubkey);
  const seen: unknown[] = [];
  disposals.push(f.service.subscribe(() => seen.push(view())));
  update();
  expect(view()?.synced).toBeUndefined();
  expect(view()?.config).toMatchObject({ instructions: "LOCAL INSTRUCTIONS" });
  // Local → synced with the same local row.
  binding.mockReturnValue(synced());
  update();
  expect(view()).toMatchObject({
    synced: { effort: "high" },
    config: { instructions: "SYNCED INSTRUCTIONS" },
  });
  // Nothing changed: the same frozen view, and no notice.
  const stable = view();
  const notices = seen.length;
  update();
  expect(view()).toBe(stable);
  expect(seen).toHaveLength(notices);
  // Deleted, then restored without touching the local row.
  const store = internals.configStore;
  const instructions = store.state(instructionsSubject).head;
  if (!instructions) throw new Error("no instructions head");
  store.applyRead(instructionsSubject, store.capture(instructionsSubject), {
    kind: "head",
    event: revision(null, "delete"),
  });
  update();
  expect(view()?.blocked).toBe(
    "Instructions were deleted — restore from History",
  );
  store.applyRead(instructionsSubject, store.capture(instructionsSubject), {
    kind: "head",
    event: instructions,
  });
  update();
  expect(view()?.blocked).toBeUndefined();
  expect(view()).toMatchObject({
    synced: { effort: "high" },
    config: { instructions: "SYNCED INSTRUCTIONS" },
  });
  expect(seen.at(-1)).toBe(view());
});
