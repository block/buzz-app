// Settings admission through the real host and each adapter's registered
// wiring: a turn runs on the settings it captured before any wait, and only
// while no Save, provider-default change or Restart has landed since. An
// ordinary Save never refuses the next message in a conversation.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { RelayEvent } from "../relay/events";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import {
  agentKey,
  disposals,
  type Fixture,
  fakeCodex,
  heads,
  plugged,
  remoteEdit,
  revision,
  setup,
  settingsSubject,
  synced,
} from "./launch-testing";
import type { AgentConfigStore } from "./agent-config";
import type { AgentType, Delivery } from "./service";
import { SUPERSEDED, type SettingsAttempt } from "./settings";
import { memoryStorage } from "./test-fakes";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import { GooseSession } from "../../bundled/goose/goose";
import { gooseRun } from "../../bundled/goose/run";
import {
  config as gooseConfig,
  GooseRuntime,
} from "../../bundled/goose/runtime";
import { GooseSetup } from "../../bundled/goose/setup";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

type Config = Record<string, string>;
type Wiring = Pick<
  AgentType<Config>,
  "run" | "runOnce" | "timeoutMs" | "syncedSettings" | "restart" | "models"
>;

/** One adapter under test: its local config on A, the model B differs by,
 * and the model each prompt it actually wrote ran on. */
type Adapter = {
  name: string;
  type: string;
  a: Config;
  b: string;
  build(hold?: Hold): {
    wire(
      runs: Parameters<typeof setup>[1] extends (...a: infer P) => unknown
        ? P
        : never,
    ): Wiring & { sync: (agents: never[]) => void };
    prompted(): string[];
    /** Whether every prompt so far was written inside a handoff. */
    writes(): number;
    /** Whether a turn has reached the model wait `hold` holds, when that
     * isn't the moment the held request is sent. */
    atPick?(): boolean;
  };
};

/** Holds an adapter at its own model wait before a picked turn hands off:
 * the reply to the request `asks` names waits until `held` opens. */
type Hold = Readonly<{ held: Promise<void>; entered(): void }>;
type Wire = Record<string, unknown>;
type Spawned = { write(data: string): unknown };
function holding<
  S extends (id: string, options?: HostProcessOptions) => Promise<Spawned>,
>(spawn: S, hold: Hold | undefined, asks: (request: Wire) => boolean): S {
  if (!hold) return spawn;
  const idOf = (message: Wire) =>
    message.request_id ??
    (message.response as Wire | undefined)?.request_id ??
    message.id;
  return (async (id: string, options: HostProcessOptions = {}) => {
    const asked = new Set<unknown>();
    const process = await spawn(id, {
      ...options,
      onStdout: (chunk: string) => {
        let message: Wire | undefined;
        try {
          message = JSON.parse(chunk) as Wire;
        } catch {
          // Not one message: passed on as is.
        }
        if (!message || !asked.delete(idOf(message)))
          return options.onStdout?.(chunk);
        hold.entered();
        void hold.held.then(() => options.onStdout?.(chunk));
      },
    });
    const write = process.write.bind(process);
    return Object.assign(process, {
      write: (data: string) => {
        for (const line of data.split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as Wire;
          if (asks(request)) asked.add(idOf(request));
        }
        return write(data);
      },
    });
  }) as S;
}

const claude: Adapter = {
  name: "Claude",
  type: "claude-code",
  // Models Claude lists, so a pick of B is offered.
  a: {
    model: "opus",
    effort: "",
    instructions: "INSTRUCTIONS",
    workspace: "/this/device",
    scope: "thread",
  },
  b: "haiku",
  build(hold) {
    const fake = fakeClaude();
    // A picked turn waits for the model list its process's `initialize`
    // answer reports.
    const spawn = holding(
      fake.spawn,
      hold,
      (request) =>
        (request.request as Wire | undefined)?.subtype === "initialize",
    );
    const host = { spawn, request: vi.fn() } as unknown as Host;
    const prompted = () => fake.processes.flatMap((process) => process.models);
    let runtime: ClaudeRuntime | undefined;
    return {
      // The spare's `initialize` is sent before any turn; a turn is at the
      // wait once its conversation's process is adopted, then answered.
      atPick: () => (runtime?.sessions(agentKey.pubkey).length ?? 0) > 0,
      wire: ([_relay, reads, core]) => {
        runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
        return Object.assign(claudeRun(runtime), {
          sync: runtime.sync.bind(runtime) as never,
        });
      },
      prompted,
      writes: () => prompted().length,
    };
  },
};

const codex: Adapter = {
  name: "Codex",
  type: "codex",
  a: {
    model: "local-model",
    effort: "low",
    instructions: "INSTRUCTIONS",
    workspace: "/this/device",
    scope: "thread",
  },
  b: "synced-model",
  build(hold) {
    const fake = fakeCodex();
    // A turn lists Codex's models before it starts.
    const spawn = holding(
      fake.spawn,
      hold,
      (request) => request.method === "model/list",
    );
    const turns = () =>
      fake.sent.filter((wire) => wire.method === "turn/start");
    return {
      wire: ([_relay, reads, core]) => {
        const runtime = new CodexRuntime(
          spawn as typeof fake.spawn,
          reads,
          core,
          memoryStorage(),
        );
        return Object.assign(codexRun(runtime), {
          sync: runtime.sync.bind(runtime) as never,
        });
      },
      prompted: () =>
        turns().map((wire) =>
          String((wire.params as Record<string, unknown>).model),
        ),
      writes: () => turns().length,
    };
  },
};

const GOOSE_PROVIDERS = [
  {
    providerId: "synced-provider",
    models: [{ modelId: "model-a" }, { modelId: "model-b" }],
  },
];
/** The model each goose prompt ran on: its session's last model set. */
function gooseModels(fake: ReturnType<typeof fakeGoose>) {
  const models: string[] = [];
  for (const goose of fake.geese) {
    const current = new Map<string, string>();
    for (const message of goose.received) {
      const params = message.params ?? {};
      const session = String(params.sessionId ?? "");
      if (
        message.method === "session/set_config_option" &&
        params.configId === "model"
      )
        current.set(session, String(params.value));
      if (message.method === "session/prompt")
        models.push(current.get(session) ?? "?");
    }
  }
  return models;
}
const gooseAdapter = (
  hold = false,
): Adapter & {
  fake?: ReturnType<typeof fakeGoose>;
} => {
  const adapter: Adapter & { fake?: ReturnType<typeof fakeGoose> } = {
    name: "goose",
    type: "goose",
    a: {
      model: "model-a",
      provider: "synced-provider",
      effort: "",
      instructions: "INSTRUCTIONS A",
      workspace: "/this/device",
      scope: "thread",
    },
    b: "model-b",
    build(pick) {
      const fake = fakeGoose({
        providers: GOOSE_PROVIDERS,
        supported: ["model-a", "model-b"],
        hold,
      });
      adapter.fake = fake;
      // A picked turn puts its session on the model before it prompts.
      const spawn = holding(
        fake.spawn,
        pick,
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as Wire | undefined)?.configId === "model" &&
          (request.params as Wire | undefined)?.value === "model-b",
      );
      const host = {
        spawn,
        resolveDirectory: fake.resolveDirectory,
        readFile: vi.fn(),
        serveMcp: fake.serve,
      } as unknown as Host;
      return {
        wire: ([relay, _reads, core]) => {
          const runtime = new GooseRuntime(host, relay, core);
          // goose's own registration offers models as its plugin does.
          const setup = new GooseSetup({
            spawn,
            resolveDirectory: fake.resolveDirectory,
          });
          return Object.assign(gooseRun(runtime), {
            models: (agent: { config: unknown }) =>
              setup.picks(gooseConfig(agent.config)),
            sync: runtime.sync.bind(runtime) as never,
          });
        },
        prompted: () => gooseModels(fake),
        writes: () => fake.geese.flatMap((goose) => goose.turns).length,
      };
    },
  };
  return adapter;
};

function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
}

type Options = Readonly<{
  /** Synced copies of these settings, rather than only the local row. */
  syncedAs?: Config;
  /** Held by the runner's model lookup for a mention that picks a model. */
  lookup?: Promise<void>;
  /** Held at the adapter's own model wait for a mention that picks one. */
  pickWait?: Promise<void>;
  /** Held after the delivery is built, before the adapter runs it, as a
   * readiness or authorization wait is. */
  ready?: Promise<void>;
  /** Wraps each delivery's attempt. */
  attempt?: (attempt: SettingsAttempt<Config>) => SettingsAttempt<Config>;
  /** Offers the adapter's own registered models, not the fixture menu. */
  ownModels?: boolean;
}>;

async function start(adapter: Adapter, options: Options = {}) {
  let defaults!: () => void;
  let looking!: () => void;
  const looked = new Promise<void>((resolve) => {
    looking = resolve;
  });
  const built = adapter.build(
    options.pickWait && { held: options.pickWait, entered: () => looking() },
  );
  let wiring!: Wiring & { sync: (agents: never[]) => void };
  const seeded = options.syncedAs
    ? heads(`buzz/${adapter.type}`, options.syncedAs).seeded
    : [];
  const f = await setup<Config>(
    adapter.type,
    (...args) => {
      wiring = built.wire(args);
      const { sync: _, ...real } = wiring;
      return {
        ...real,
        models: async (agent) => {
          if (options.ownModels && real.models) return real.models(agent);
          looking();
          await options.lookup;
          const model = agent.config.model ?? "";
          return {
            current: model,
            models: [model, adapter.b].map((id) => ({
              id,
              label: id,
              efforts: [],
            })),
          } as never;
        },
        defaultsChanged: (listener: () => void) => {
          defaults = listener;
          return () => {};
        },
        run: async (delivery: Delivery<Config>) => {
          await options.ready;
          return real.run?.(
            options.attempt
              ? { ...delivery, attempt: options.attempt(delivery.attempt) }
              : delivery,
          );
        },
      } as Wiring;
    },
    adapter.a,
    seeded,
    options.syncedAs ? synced() : synced("local"),
  );
  const sync = plugged(f, wiring as never);
  return { f, built, sync, looked, defaults: () => defaults() };
}

/** The mention's single outcome, once its work has ended. */
async function outcome(f: Fixture, sent: RelayEvent) {
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(["done", "error"]).toContain(work()[0]?.state));
  return work()[0]?.error;
}

const pick = (model: string) => [[MODEL_TAG, agentKey.pubkey, model]];
const saveModel = (f: Fixture, adapter: Adapter, model: string) =>
  f.service.save(agentKey.pubkey, { config: { ...adapter.a, model } });

/** Another device deletes the synced settings: the agent is blocked. */
function remoteDelete(f: Fixture) {
  const store = (f.service as unknown as { configStore: AgentConfigStore })
    .configStore;
  store.applyRead(settingsSubject, store.capture(settingsSubject), {
    kind: "head",
    event: revision(null, "delete"),
  });
}

/** A picked turn's model lookup overtaken by a Save, a revert, a
 * provider-default change or a Restart: refused, with no prompt written.
 * `adapter` waits for it in the runner (a type without synced settings) or
 * at its own model wait before `handoff` (one with them). */
function lookupRaces(adapter: Adapter, at: "runner" | "adapter") {
  const waiting = (held: Promise<void>): Options =>
    at === "runner" ? { lookup: held } : { pickWait: held };
  /** Held at its lookup: the delivery is built only for the adapter's own. */
  const holds = async (
    f: Fixture,
    looked: Promise<void>,
    atPick?: () => boolean,
  ) => {
    await looked;
    if (at === "adapter") {
      await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
      await vi.waitFor(() => expect(atPick?.() ?? true).toBe(true));
    }
  };
  const delivered = (f: Fixture) =>
    expect(f.deliveries).toHaveLength(at === "runner" ? 0 : 1);

  it("refuses a turn whose model lookup a Save overtook, and runs the next on the Save", async () => {
    const lookup = gate();
    const { f, built, looked } = await start(adapter, {
      ...waiting(lookup.held),
    });
    const sent = f.mention(pick(adapter.b));
    await holds(f, looked, built.atPick);
    await saveModel(f, adapter, adapter.b);
    lookup.open();
    expect(await outcome(f, sent)).toBe(SUPERSEDED);

    delivered(f);
    expect(built.prompted()).toEqual([]);

    const next = f.mention();
    expect(await outcome(f, next)).toBeUndefined();
    expect(built.prompted()).toEqual([adapter.b]);
  });

  it("refuses a Save then a revert during the lookup: the counter, not the content, decides", async () => {
    const lookup = gate();
    const { f, built, looked } = await start(adapter, {
      ...waiting(lookup.held),
    });
    const sent = f.mention(pick(adapter.b));
    await holds(f, looked, built.atPick);
    await saveModel(f, adapter, adapter.b);
    await saveModel(f, adapter, adapter.a.model ?? "");
    lookup.open();
    expect(await outcome(f, sent)).toBe(SUPERSEDED);

    delivered(f);
    expect(built.prompted()).toEqual([]);
  });

  it("refuses a turn whose lookup a provider-default change overtook", async () => {
    const lookup = gate();
    const { f, built, defaults, looked } = await start(adapter, {
      ...waiting(lookup.held),
    });
    const sent = f.mention(pick(adapter.b));
    await holds(f, looked, built.atPick);
    defaults();
    lookup.open();
    expect(await outcome(f, sent)).toBe(SUPERSEDED);

    delivered(f);
    expect(built.prompted()).toEqual([]);
    const next = f.mention();
    expect(await outcome(f, next)).toBeUndefined();
    expect(built.prompted()).toHaveLength(1);
  });

  // Restart applies only to a type that has it, which syncs its settings.
  if (at === "adapter")
    it.each([
      ["healthy", false],
      ["blocked", true],
    ])(
      "refuses a turn whose lookup a Restart onto a %s replacement overtook",
      async (_, blocked) => {
        const lookup = gate();
        const { f, built, sync, looked } = await start(adapter, {
          ...waiting(lookup.held),
          syncedAs: { model: adapter.a.model ?? "", scope: "thread" },
        });
        const sent = f.mention(pick(adapter.b));
        await holds(f, looked, built.atPick);
        if (blocked) remoteDelete(f);
        sync();
        f.service.restart(agentKey.pubkey);
        lookup.open();
        expect(await outcome(f, sent)).toBe(SUPERSEDED);

        delivered(f);
        expect(built.prompted()).toEqual([]);
        const next = f.mention();
        if (blocked)
          expect(await outcome(f, next)).toBe(
            "Settings were deleted — restore from History",
          );
        else expect(await outcome(f, next)).toBeUndefined();
        expect(built.prompted()).toHaveLength(blocked ? 0 : 1);
      },
    );
}

/** A type without synced settings: it never pins, so the runner checks a
 * pick against the models it lists now. Each run records the model it ran. */
const plain: Adapter = {
  name: "Plain",
  type: "plain",
  a: { model: "model-a" },
  b: "model-b",
  build() {
    const prompted: string[] = [];
    return {
      wire: () => ({
        run: async (delivery: Delivery<Config>) => {
          prompted.push(
            delivery.model ?? delivery.attempt.settings.config.model ?? "",
          );
        },
        sync: () => {},
      }),
      prompted: () => prompted,
      writes: () => prompted.length,
    };
  },
};

describe("Plain admission", () => lookupRaces(plain, "runner"));

describe.each([claude, codex, gooseAdapter()])("$name admission", (adapter) => {
  lookupRaces(adapter, "adapter");
  it("prompts on B after a local Save in a conversation running on A, never refusing it", async () => {
    const { f, built } = await start(adapter);
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    expect(built.prompted()).toEqual([adapter.a.model]);
    await saveModel(f, adapter, adapter.b);
    const reply = f.reply(root);
    expect(await outcome(f, reply)).toBeUndefined();
    expect(built.prompted()).toEqual([adapter.a.model, adapter.b]);
  });

  it.each([
    ["healthy", false],
    ["blocked", true],
  ])(
    "keeps a conversation on A across a %s remote edit until Restart, then runs B only when it can",
    async (_, blocked) => {
      const { f, built, sync } = await start(adapter, {
        syncedAs: { model: adapter.a.model ?? "", scope: "thread" },
      });
      const root = f.mention();
      expect(await outcome(f, root)).toBeUndefined();
      if (blocked) remoteDelete(f);
      else
        (
          f.service as unknown as { configStore: AgentConfigStore }
        ).configStore.applyRead(
          settingsSubject,
          (
            f.service as unknown as { configStore: AgentConfigStore }
          ).configStore.capture(settingsSubject),
          {
            kind: "head",
            event: revision({
              agentType: `buzz/${adapter.type}`,
              settings: { model: adapter.b, scope: "thread" },
            }),
          },
        );
      sync();
      // A remote edit leaves the conversation pinned to A, even one that
      // blocks the settings: only where they would be used are they refused.
      expect(await outcome(f, f.reply(root))).toBeUndefined();
      expect(built.prompted()).toEqual([adapter.a.model, adapter.a.model]);
      if (blocked) {
        expect(await outcome(f, f.mention())).toBe(
          "Settings were deleted — restore from History",
        );
        expect(built.prompted()).toHaveLength(2);
      }

      f.service.restart(agentKey.pubkey);
      const after = f.reply(root);
      if (blocked) {
        expect(await outcome(f, after)).toBe(
          "Settings were deleted — restore from History",
        );
        expect(built.prompted()).toHaveLength(2);
      } else {
        expect(await outcome(f, after)).toBeUndefined();
        expect(built.prompted().at(-1)).toBe(adapter.b);
      }
    },
  );

  it("refuses a delivery a Save overtook while it waited to run, and runs the next on the Save", async () => {
    const ready = gate();
    const { f, built } = await start(adapter, { ready: ready.held });
    const sent = f.mention();
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
    await saveModel(f, adapter, adapter.b);
    ready.open();
    expect(await outcome(f, sent)).toBe(SUPERSEDED);

    expect(built.prompted()).toEqual([]);
    expect(await outcome(f, f.mention())).toBeUndefined();
    expect(built.prompted()).toEqual([adapter.b]);
  });

  it("runs an explicit pick in a pinned conversation after a remote edit, and refuses one it doesn't offer", async () => {
    const { f, built, sync } = await start(adapter, {
      syncedAs: { model: adapter.a.model ?? "", scope: "thread" },
    });
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    // Another device moves the latest settings to a model no list offers.
    remoteEdit(f, `buzz/${adapter.type}`, {
      model: "remote-model",
      scope: "thread",
    });
    sync();
    expect(await outcome(f, f.reply(root, pick(adapter.b)))).toBeUndefined();
    expect(built.prompted()).toEqual([adapter.a.model, adapter.b]);
    if (adapter.name === "goose") {
      const goose = gooseOf(adapter);
      goose.configCode = -32602;
      goose.configError = "Invalid model config";
    }
    // Nothing offers it, so it never reaches a prompt.
    expect(await outcome(f, f.reply(root, pick("unoffered")))).toMatch(
      /unoffered|Invalid model config/,
    );
    expect(built.prompted()).toEqual([adapter.a.model, adapter.b]);
    // goose itself rejected the pick, not the model it would fall back to.
    if (adapter.name === "goose")
      expect(
        gooseOf(adapter).received.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "unoffered",
        ),
      ).toBe(true);
  });

  it("writes every prompt inside the shared check", async () => {
    let inside = 0;
    const built = { writes: () => 0 };
    const started = await start(adapter, {
      attempt: (attempt) =>
        Object.freeze({
          ...attempt,
          handoff: (selected, send) =>
            attempt.handoff(selected, () => {
              const before = built.writes();
              const sent = send();
              inside += built.writes() - before;
              return sent;
            }),
        }),
    });
    built.writes = started.built.writes;
    const { f } = started;
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    expect(await outcome(f, f.reply(root))).toBeUndefined();
    expect(await outcome(f, f.mention())).toBeUndefined();
    expect(started.built.writes()).toBe(3);
    expect(inside).toBe(3);
  });
});

const gooseOf = (adapter: Adapter) => {
  const goose = (adapter as ReturnType<typeof gooseAdapter>).fake?.geese[0];
  if (!goose) throw new Error("goose never started");
  return goose;
};

describe("goose picks", () => {
  it("runs a pick for its own turn only: the next plain message runs on A's model", async () => {
    const adapter = gooseAdapter();
    const { f, built } = await start(adapter);
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    expect(await outcome(f, f.reply(root, pick(adapter.b)))).toBeUndefined();
    expect(await outcome(f, f.reply(root))).toBeUndefined();
    expect(built.prompted()).toEqual(["model-a", "model-b", "model-a"]);
  });

  it("runs a pick its own registration offers for that turn only", async () => {
    const adapter = gooseAdapter();
    const { f, built } = await start(adapter, { ownModels: true });
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    expect(await outcome(f, f.reply(root, pick(adapter.b)))).toBeUndefined();
    expect(await outcome(f, f.reply(root))).toBeUndefined();
    expect(built.prompted()).toEqual(["model-a", "model-b", "model-a"]);
  });

  it("refuses a picked effort, which goose can't take per turn", async () => {
    const adapter = gooseAdapter();
    const { f, built } = await start(adapter);
    const sent = f.mention([[EFFORT_TAG, agentKey.pubkey, "high"]]);
    expect(await outcome(f, sent)).toMatch(/picked effort "high"/);
    expect(built.prompted()).toEqual([]);
  });
});

describe("goose sessions across a Save", () => {
  it("switches an idle open session to a model-only Save and prompts on it there", async () => {
    const adapter = gooseAdapter();
    const { f, built } = await start(adapter);
    const root = f.mention();
    expect(await outcome(f, root)).toBeUndefined();
    await saveModel(f, adapter, adapter.b);
    expect(await outcome(f, f.reply(root))).toBeUndefined();
    expect(built.prompted()).toEqual(["model-a", "model-b"]);
    const [goose] = adapter.fake?.geese ?? [];
    expect(goose?.opened).toHaveLength(1);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
  });

  it.each([
    ["opens a new session on B once the busy turn ends", false],
    ["refuses on a blocked B", true],
  ])(
    "a message that can't steer into a busy session after an instructions Save %s, never prompting the old session",
    async (_, blocked) => {
      const adapter = gooseAdapter(true);
      const { f, sync } = await start(
        adapter,
        blocked
          ? {
              syncedAs: {
                model: "model-a",
                provider: "synced-provider",
                scope: "thread",
              },
            }
          : {},
      );
      const goose = () => adapter.fake?.geese[0];
      const root = f.mention();
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      if (blocked) {
        remoteDelete(f);
        sync();
        f.service.restart(agentKey.pubkey);
      } else
        await f.service.save(agentKey.pubkey, {
          config: { ...adapter.a, instructions: "INSTRUCTIONS B" },
        });
      // A different model can't steer into the running turn, so the reply
      // waits for it to end.
      const waiting = new Promise<void>((resolve) => {
        const idle = GooseSession.prototype.idle;
        vi.spyOn(GooseSession.prototype, "idle").mockImplementation(function (
          this: GooseSession,
        ) {
          resolve();
          return idle.call(this);
        });
      });
      const reply = f.reply(root, pick("model-b"));
      await waiting;
      expect(goose()?.turns).toHaveLength(1);
      goose()?.turns[0]?.finish();
      if (blocked) {
        expect(await outcome(f, reply)).toBe(
          "Settings were deleted — restore from History",
        );
        expect(goose()?.turns).toHaveLength(1);
        return;
      }
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
      expect(goose()?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        "session-2",
      ]);
      expect(goose()?.prompts.get("session-2")).toContain("INSTRUCTIONS B");
      goose()?.turns[1]?.finish();
      expect(await outcome(f, reply)).toBeUndefined();
    },
  );
});
