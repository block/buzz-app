import { afterEach, expect, it, vi } from "vitest";
import { link, type Link, type LinkPort, type Served } from "./link";
import { createLocalAgentActivity } from "./local-activity";
import { agentKey } from "./membership";
import type { Synced } from "./agent-start";
import type { Attention, RunnerStatus } from "./agents-runner";
import { blank, type Member, type RecordEdit } from "./records";
import {
  linkedActivity,
  managerSide,
  routed,
  runnerSide,
  serveActivity,
} from "./runner-link";
import type {
  Agent,
  RegisteredAgentType,
  SessionControlAction,
  SessionPlace,
  SessionState,
} from "./service";
import type { AgentRecord, Team } from "./store";
import type { Teammate } from "./team-prompt";

const open: Link[] = [];
afterEach(() => {
  for (const side of open.splice(0)) side.close();
});

function linked() {
  const activity = createLocalAgentActivity();
  const channel = new MessageChannel();
  const runner = link(channel.port1, serveActivity(activity.reader));
  const manager = link(channel.port2);
  open.push(runner, manager);
  return { activity, source: linkedActivity(manager).source };
}

const request = {
  scope: "wss://relay.example",
  agent: "a".repeat(64),
  channelId: "channel",
  messageId: "message",
  threadRootId: "message",
};

it("shows the Runner's local work, and keeps rows until they change", async () => {
  const { activity, source } = linked();
  const heard = vi.fn();
  source.subscribeWork(heard);
  const work = activity.begin(request);
  work.started();
  work.step("Read", "notes.md");
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([
      { ...request, state: "working", step: { tool: "Read" } },
    ]),
  );
  const rows = source.work();
  expect(Object.isFrozen(rows[0])).toBe(true);
  heard.mockClear();
  // A step with the same text is no change, so nothing is sent.
  work.step("Read", "notes.md");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(heard).not.toHaveBeenCalled();
  expect(source.work()).toBe(rows);
});

it("stops a turn and hides an error through the Runner", async () => {
  const { activity, source } = linked();
  const stop = vi.fn(async () => {});
  const running = activity.begin(request);
  running.started();
  running.interruptible(stop);
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([{ stoppable: true }]),
  );
  await source.interrupt?.(request);
  expect(stop).toHaveBeenCalledTimes(1);
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([{ state: "stopped" }]),
  );

  const failed = activity.begin({ ...request, messageId: "other" });
  failed.finish({ ok: false, error: "No credits left" });
  await vi.waitFor(() =>
    expect(source.work()).toContainEqual(
      expect.objectContaining({ messageId: "other", state: "error" }),
    ),
  );
  source.dismissError?.({ ...request, messageId: "other" });
  await vi.waitFor(() =>
    expect(source.work()).toContainEqual(
      expect.objectContaining({ messageId: "other", dismissed: true }),
    ),
  );
});

const owner = "b".repeat(64);
const member = (pubkey: string, name: string): Member => ({
  key: pubkey,
  pubkey,
  relay: "wss://relay.example",
  owner,
  type: "test/agent",
  name,
  deleted: false,
});
const agentOf = (identity: Member) =>
  ({
    ...identity,
    place: "here",
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: false,
    config: { reply: "ok" },
  }) as unknown as Agent;

/** A Runner that runs each membership it is sent, and marks those named in
 * `left` interrupted. */
function fakeRunner() {
  const listeners = new Set<() => void>();
  let running: readonly Agent[] = [];
  const left = new Set<string>();
  const recordListeners = new Set<() => void>();
  let saved: Record<string, AgentRecord> = {};
  let status: RunnerStatus = { runs: [], yielded: [], transitioning: [] };
  let types: Record<string, string> = {};
  let kinds: readonly RegisteredAgentType[] = [];
  const typeListeners = new Set<() => void>();
  const runner = {
    members: vi.fn(
      (identities: readonly Member[], _viewer?: string, _loaded?: boolean) => {
        const next = identities.map(
          (identity) =>
            running.find(
              (agent) =>
                agent.key === identity.key && agent.name === identity.name,
            ) ?? agentOf(identity),
        );
        const changed =
          next.length !== running.length ||
          next.some((agent, index) => agent !== running[index]);
        running = next;
        if (changed) for (const listener of [...listeners]) listener();
      },
    ),
    running: () => running,
    interrupted: () => running.filter((agent) => left.has(agent.key)),
    runnerStatus: () => status,
    /** Another copy took an agent, or a change of type began or ended. */
    hold(next: RunnerStatus) {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    edit: (key: string, edit: RecordEdit) => runner.records.edit(key, edit),
    session: vi.fn(
      async (
        _key: string,
        _type: string,
        _place: SessionPlace,
        _action: SessionControlAction,
      ) => {},
    ),
    protect: vi.fn(
      async (
        _pubkey: string,
        _revision: number,
        _provider: string,
        _policy: unknown,
      ) => {},
    ),
    // Saves the config, and the type it is shown with, at once.
    retype: vi.fn(
      async (key: string, type: string, config: unknown, _publish: boolean) => {
        await Promise.resolve();
        saved = { ...saved, [key]: { ...(saved[key] ?? blank(key)), config } };
        types = { ...types, [key]: type };
        for (const listener of [...recordListeners]) listener();
      },
    ),
    retypes: () => types,
    types: () => kinds,
    setTeams: vi.fn(
      (
        _teams: readonly Team[],
        _teammates: Readonly<Record<string, readonly Teammate[]>>,
      ) => {},
    ),
    setAttention: vi.fn((_attention: Attention) => {}),
    setSynced: vi.fn((_synced: Readonly<Record<string, Synced>>) => {}),
    resumeInterrupted: vi.fn((_keys: readonly string[]) => {}),
    dismissInterrupted: vi.fn((_keys: readonly string[]) => {}),
    /** The types that run here change, as when a plugin reloads. */
    setTypes(next: readonly RegisteredAgentType[]) {
      kinds = next;
      for (const listener of [...typeListeners]) listener();
    },
    subscribeTypes(listener: () => void) {
      typeListeners.add(listener);
      return () => {
        typeListeners.delete(listener);
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    records: {
      all: () => Object.values(saved),
      edit: vi.fn(async (key: string, edit: RecordEdit) => {
        await Promise.resolve();
        if (edit.kind === "remove") {
          const { [key]: _, ...rest } = saved;
          saved = rest;
        } else if (edit.kind === "create")
          saved = { ...saved, [key]: edit.record };
        for (const listener of [...recordListeners]) listener();
      }),
    },
    subscribeRecords(listener: () => void) {
      recordListeners.add(listener);
      return () => {
        recordListeners.delete(listener);
      };
    },
  };
  return { runner, left };
}

/** A new agent's settings, as its type gives them. */
const defaults = vi.fn(
  ({ pubkey }: Pick<Member, "pubkey">): AgentRecord => ({
    pubkey,
    attention: {},
    config: { reply: "default" },
  }),
);

function split(identities: Member[] = []) {
  const { runner, left } = fakeRunner();
  const channel = new MessageChannel();
  let shown: Member[] = identities;
  const changed = vi.fn();
  const retyped = vi.fn((_types: Readonly<Record<string, string>>) => {});
  const runnerLink = runnerSide(channel.port1, runner);
  const shares = new Map<string, Served>();
  let teams: readonly Team[] = [];
  let teammates: Readonly<Record<string, readonly Teammate[]>> = {};
  let synced: Readonly<Record<string, Synced>> = {};
  const asks = {
    createAgent: vi.fn(async () => ({
      requestId: "made",
      saved: false as const,
    })),
    updateAgent: vi.fn(async () => ({
      requestId: "changed",
      saved: false as const,
    })),
    templates: vi.fn(async () => [{ name: "Team", canvas: "", agents: [] }]),
    publishType: vi.fn(
      async (_key: string, _type: string, _config: unknown) => {},
    ),
    finished: vi.fn((_key: string) => {}),
    refresh: vi.fn(async () => {}),
  };
  const sharesChanged = new Set<() => void>();
  const manager = managerSide(channel.port2, {
    members: () => ({
      loaded: true,
      identities: shown,
      viewer: owner,
      teams,
      teammates,
      attention: { shown: true, settled: true },
      synced,
    }),
    defaults,
    retyped: (types) => retyped(types),
    changed,
    createAgent: asks.createAgent,
    updateAgent: asks.updateAgent,
    templates: asks.templates,
    publishType: asks.publishType,
    finished: asks.finished,
    refresh: asks.refresh,
    shared: (plugin) => shares.get(plugin),
    subscribeShared(listener) {
      sharesChanged.add(listener);
      return () => sharesChanged.delete(listener);
    },
  });
  open.push(runnerLink);
  closing.push(manager);
  return {
    runner,
    left,
    manager,
    runnerLink,
    changed,
    retyped,
    asks,
    tell(
      next: Readonly<{
        teams?: readonly Team[];
        teammates?: Readonly<Record<string, readonly Teammate[]>>;
        synced?: Readonly<Record<string, Synced>>;
      }>,
    ) {
      teams = next.teams ?? teams;
      teammates = next.teammates ?? teammates;
      synced = next.synced ?? synced;
      manager.changed();
    },
    share(plugin: string, served: Served | undefined) {
      if (served) shares.set(plugin, served);
      else shares.delete(plugin);
      for (const listener of [...sharesChanged]) listener();
    },
    show(next: Member[]) {
      shown = next;
      manager.changed();
    },
  };
}
const closing: { close(): void }[] = [];
afterEach(() => {
  for (const side of closing.splice(0)) side.close();
});

it("lets the Runner decide from the Manager's memberships, and waits for it", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show } = split();
  show([ada]);
  await manager.decided();
  expect(runner.members).toHaveBeenLastCalledWith([ada], owner, true);
  expect(manager.running()).toEqual([agentOf(ada)]);
  expect(manager.agent(ada.key)?.name).toBe("Ada");
  expect(Object.isFrozen(manager.running()[0])).toBe(true);
  // An unchanged list is not sent again, so there is nothing to wait for.
  const calls = runner.members.mock.calls.length;
  show([{ ...ada }]);
  await manager.decided();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runner.members).toHaveBeenCalledTimes(calls);
});

it("settles a wait even when nothing that runs changed", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show } = split([ada]);
  show([ada]);
  await manager.decided();
  const shown = manager.running();
  // Deleted elsewhere and back: what runs is the same, the list is not.
  show([{ ...ada, deleting: true }]);
  await manager.decided();
  expect(runner.members).toHaveBeenLastCalledWith(
    [{ ...ada, deleting: true }],
    owner,
    true,
  );
  expect(manager.running()).toBe(shown);
});

it("keeps each agent the Runner did not change, and shows which were interrupted", async () => {
  const ada = member("a".repeat(64), "Ada");
  const bo = member("c".repeat(64), "Bo");
  const { manager, left, show } = split();
  left.add(bo.key);
  show([ada, bo]);
  await manager.decided();
  const [first, second] = manager.running();
  expect(manager.interrupted()).toEqual([second]);
  show([ada, { ...bo, name: "Bea" }]);
  await manager.decided();
  expect(manager.running()[0]).toBe(first);
  expect(manager.running()[1]).not.toBe(second);
  expect(manager.running()[1]?.name).toBe("Bea");
  expect(manager.interrupted()).toEqual([manager.running()[1]]);
});

it("settles a wait when its side closes, since nothing decides then", async () => {
  const { manager, show } = split();
  show([member("a".repeat(64), "Ada")]);
  const waiting = manager.decided();
  manager.close();
  await expect(waiting).resolves.toBeUndefined();
  // Nor does it wait on what changes later.
  show([member("c".repeat(64), "Bo")]);
  await expect(manager.decided()).resolves.toBeUndefined();
});

it("waits for the Runner to decide when it could not, rather than forever", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show } = split();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runner.members.mockImplementationOnce(() => {
    throw new Error("broken type");
  });
  show([ada]);
  await manager.decided();
  expect(error).toHaveBeenCalledWith(
    "The Runner could not decide what runs",
    expect.any(Error),
  );
  error.mockRestore();
});

it("does not take what the Runner decided for a page that reloaded as an answer", async () => {
  const { runner } = fakeRunner();
  // The Runner's port, which reaches whichever Manager page is loaded.
  let to: MessagePort | undefined;
  const port: LinkPort = {
    onmessage: null,
    postMessage: (message) => to?.postMessage(message),
    close() {},
  };
  const load = (identities: () => Member[]) => {
    const channel = new MessageChannel();
    to = channel.port1;
    channel.port1.onmessage = (event) => port.onmessage?.(event);
    const page = managerSide(channel.port2, {
      members: () => ({
        loaded: true,
        identities: identities(),
        viewer: owner,
        teams: [],
        teammates: {},
        attention: { shown: true, settled: true },
        synced: {},
      }),
      defaults: () => undefined,
      retyped: () => {},
      changed: () => {},
      createAgent: async () => ({ requestId: "", saved: false }),
      updateAgent: async () => ({ requestId: "", saved: false }),
      templates: async () => [],
      publishType: async () => {},
      finished: () => {},
      refresh: async () => {},
      shared: () => undefined,
      subscribeShared: () => () => {},
    });
    closing.push(page);
    return page;
  };
  const ada = member("a".repeat(64), "Ada");
  const bo = member("c".repeat(64), "Bo");
  // Its first load sends two revisions.
  let shown = [ada];
  const first = load(() => shown);
  open.push(runnerSide(port, runner));
  first.changed();
  shown = [ada, bo];
  first.changed();
  await first.decided();
  expect(runner.members).toHaveBeenLastCalledWith([ada, bo], owner, true);
  // The reloaded page's first revision is not the Runner's last one.
  const second = load(() => [bo]);
  second.changed();
  await second.decided();
  expect(runner.members).toHaveBeenLastCalledWith([bo], owner, true);
  expect(second.running().map((agent) => agent.name)).toEqual(["Bo"]);
});

it("shows the Runner's records, and settles an edit once it is shown", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show, changed } = split();
  show([ada]);
  await manager.decided();
  // Until the Runner keeps one, its type's defaults, the same each time.
  const first = manager.records.settingsOf(ada);
  expect(first.config).toEqual({ reply: "default" });
  expect(manager.records.settingsOf(ada)).toBe(first);
  expect(manager.records.keys()).toEqual([]);
  const record = { pubkey: ada.key, attention: {}, config: { reply: "mine" } };
  changed.mockClear();
  await manager.records.edit(ada.key, { kind: "create", record });
  expect(runner.records.edit).toHaveBeenCalledWith(ada.key, {
    kind: "create",
    record,
  });
  expect(changed).toHaveBeenCalled();
  expect(manager.records.keys()).toEqual([ada.key]);
  const kept = manager.records.recordOf(ada);
  expect(kept).toEqual(record);
  // An unchanged record keeps its identity when another changes.
  const bo = member("c".repeat(64), "Bo");
  await manager.records.edit(bo.key, {
    kind: "create",
    record: { ...record, pubkey: bo.key },
  });
  expect(manager.records.recordOf(ada)).toBe(kept);
  await manager.records.edit(ada.key, { kind: "remove" });
  expect(manager.records.keys()).toEqual([bo.key]);
});

it("gives a membership outside its home its own attention and the agent's config", async () => {
  const ada = member("a".repeat(64), "Ada");
  const away: Member = {
    ...ada,
    key: agentKey(ada.pubkey, "https://other.example", "https://relay.example"),
    relay: "wss://other.example",
    home: "wss://relay.example",
  };
  const { manager, show } = split();
  show([ada, away]);
  await manager.decided();
  await manager.records.edit(ada.key, {
    kind: "create",
    record: { pubkey: ada.key, attention: {}, config: { reply: "home" } },
  });
  expect(manager.records.recordOf(away)).toEqual({
    pubkey: away.key,
    attention: {},
    config: { reply: "home" },
  });
});

it("shows who holds each agent, keeping it while unchanged", async () => {
  const ada = member("a".repeat(64), "Ada");
  const bo = member("c".repeat(64), "Bo");
  const { runner, manager, show } = split();
  show([ada]);
  await manager.decided();
  expect(manager.runs(ada.key)).toBe(false);
  runner.hold({ runs: [ada.key], yielded: [], transitioning: [] });
  await vi.waitFor(() => expect(manager.runs(ada.key)).toBe(true));
  const held = manager.status();
  expect(manager.yielded(ada.key)).toBe(false);
  expect(manager.transitioning(ada.key)).toBe(false);
  // What it decided changed, but not who holds what.
  show([ada, bo]);
  await manager.decided();
  expect(manager.status()).toBe(held);
  runner.hold({ runs: [ada.key], yielded: [bo.key], transitioning: [ada.key] });
  await vi.waitFor(() => expect(manager.transitioning(ada.key)).toBe(true));
  expect(manager.yielded(bo.key)).toBe(true);
});

it("shows a retyped agent's new type only with its new config", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show, retyped } = split();
  show([ada]);
  await manager.decided();
  const seen: unknown[] = [];
  retyped.mockImplementation((types) =>
    seen.push([types, manager.records.settingsOf(ada).config]),
  );
  await manager.retype(ada.key, "example/other", { reply: "other" }, true);
  expect(runner.retype).toHaveBeenCalledWith(
    ada.key,
    "example/other",
    { reply: "other" },
    true,
  );
  // Settled only once the type and its config were both shown.
  expect(seen).toEqual([[{ [ada.key]: "example/other" }, { reply: "other" }]]);
});

it("asks the Runner to run a session control", async () => {
  const ada = member("a".repeat(64), "Ada");
  const { runner, manager, show } = split();
  show([ada]);
  await manager.decided();
  const place = { channelId: "c".repeat(64), root: "d".repeat(64) };
  await manager.session(ada.key, "example/echo", place, "compact");
  expect(runner.session).toHaveBeenCalledWith(
    ada.key,
    "example/echo",
    place,
    "compact",
  );
});

/** An agent type that runs here, as its plugin's agent entry registers it. */
function echoType(revision = "one") {
  let count = 1;
  let state: SessionState = "idle";
  let readiness: "checking" | "ready" = "checking";
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const attend = vi.fn();
  const type: RegisteredAgentType = {
    key: "example/echo",
    id: "echo",
    pluginId: "example",
    revision,
    title: "Echo",
    defaults: () => ({ config: { reply: "ok", unset: undefined } }),
    expose: {
      topics: { count: () => ({ get: () => count, subscribe }) },
      commands: {
        add: (more) => {
          count += more as number;
          notify();
          return count;
        },
      },
    },
    models: async (agent) => ({ current: agent.name, models: [] }),
    sessionControls: {
      state: () => state,
      run: async () => {},
      subscribe,
    },
    provider: {
      snapshot: () => ({ readiness }),
      subscribe,
      check: () => {
        readiness = "ready";
        notify();
      },
      get attentionAction() {
        return readiness === "ready" ? attend : undefined;
      },
    },
  };
  return {
    type,
    attend,
    compact() {
      state = "compacting";
      notify();
    },
  };
}
const hosted: RegisteredAgentType = {
  key: "hosted/remote",
  id: "remote",
  pluginId: "hosted",
  revision: "one",
  title: "Hosted",
  defaults: () => ({ config: {} }),
  remote: {} as NonNullable<RegisteredAgentType["remote"]>,
};

it("tells the Manager only the types that run here, as JSON, and serves what each UI reaches", async () => {
  const { runner, manager } = split();
  const echo = echoType();
  runner.setTypes([echo.type, hosted]);
  await vi.waitFor(() => expect(manager.types()).toHaveLength(1));
  const [info] = manager.types();
  if (!info) throw new Error("no type");
  expect(info).toMatchObject({
    key: "example/echo",
    revision: "one",
    title: "Echo",
    // A field the type left undefined does not cross.
    defaults: { config: { reply: "ok" } },
    has: { models: true, usage: false, sessionControls: true, provider: true },
  });
  expect(info.defaults).toEqual({ config: { reply: "ok" } });
  const runtime = manager.runtime(info);
  runtime.watch("count", null, () => {});
  await vi.waitFor(() => expect(runtime.read("count")).toBe(1));
  // A command answers after the values it changed.
  await expect(runtime.call("add", 2)).resolves.toBe(3);
  expect(runtime.read("count")).toBe(3);
  await expect(runtime.call("missing")).rejects.toThrow("no command missing");
  await expect(
    manager.models(info, agentOf(member("a".repeat(64), "Ada"))),
  ).resolves.toEqual({ current: "Ada", models: [] });
  // A type that went away, or is now another revision, answers nothing.
  runner.setTypes([echoType("two").type]);
  await vi.waitFor(() => expect(manager.types()[0]?.revision).toBe("two"));
  await expect(runtime.call("add", 1)).rejects.toThrow(
    "That agent type is not available",
  );
  runtime.close();
});

it("shows a type's session state and provider from the Runner, and asks it to act", async () => {
  const { runner, manager } = split();
  const echo = echoType();
  runner.setTypes([echo.type]);
  await vi.waitFor(() => expect(manager.types()).toHaveLength(1));
  const [info] = manager.types();
  if (!info) throw new Error("no type");
  const ada = agentOf(member("a".repeat(64), "Ada"));
  const place = { channelId: "channel" };
  const sessions = vi.fn();
  manager.watchSession(info, ada, place, sessions);
  await vi.waitFor(() =>
    expect(manager.sessionState(info, ada, place)).toBe("idle"),
  );
  echo.compact();
  await vi.waitFor(() =>
    expect(manager.sessionState(info, ada, place)).toBe("compacting"),
  );
  expect(sessions).toHaveBeenCalled();
  manager.watchProvider(info, () => {});
  await vi.waitFor(() =>
    expect(manager.provider(info)).toEqual({
      snapshot: { readiness: "checking" },
      attend: false,
    }),
  );
  await manager.check(info);
  expect(manager.provider(info)).toEqual({
    snapshot: { readiness: "ready" },
    attend: true,
  });
  await manager.attend(info);
  expect(echo.attend).toHaveBeenCalledOnce();
});

it("gives a plugin's agent entry what its UI shares, from when it shares, and follows a new share", async () => {
  const { share, runnerLink } = split();
  const reached = routed(runnerLink, "plugin", { plugin: "github" });
  const other = routed(runnerLink, "plugin", { plugin: "other" });
  closing.push(reached, other);
  const changed = vi.fn();
  reached.watch("signIn", null, changed);
  other.watch("signIn", null, () => {});
  // Nothing is shared yet: the topic reads as null, and calls fail.
  await vi.waitFor(() => expect(reached.read("signIn")).toBeNull());
  await expect(reached.call("open", { target: "x" })).rejects.toThrow(
    "The plugin's UI has no command open",
  );
  let value = { credential: "one" };
  const listeners = new Set<() => void>();
  const opened = vi.fn((args: unknown) => args === null);
  share("github", {
    topics: {
      signIn: () => ({
        get: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    },
    commands: { open: opened },
  });
  await vi.waitFor(() =>
    expect(reached.read("signIn")).toEqual({ credential: "one" }),
  );
  expect(other.read("signIn")).toBeNull();
  await expect(reached.call("open")).resolves.toBe(true);
  value = { credential: "two" };
  for (const listener of [...listeners]) listener();
  await vi.waitFor(() =>
    expect(reached.read("signIn")).toEqual({ credential: "two" }),
  );
  // A plugin that starts again shares anew; the old share is not watched.
  share("github", {
    topics: {
      signIn: () => ({ get: () => "again", subscribe: () => () => {} }),
    },
  });
  await vi.waitFor(() => expect(reached.read("signIn")).toBe("again"));
  expect(listeners.size).toBe(0);
  share("github", undefined);
  await vi.waitFor(() => expect(reached.read("signIn")).toBeNull());
  expect(changed).toHaveBeenCalled();
});

it("tells the Runner the teams and synced settings, and takes what it asks of the Manager", async () => {
  const { runner, runnerLink, manager, asks, tell } = split();
  const team: Team = { id: "t", name: "Crew", instructions: "", members: [] };
  const overlay: Synced = {
    ok: true,
    settings: { model: "big" },
    revisions: ["r1"],
  };
  const crew = { "wss://relay.test": [{ pubkey: "b".repeat(64) }] };
  tell({ teams: [team], teammates: crew, synced: { a: overlay } });
  await vi.waitFor(() =>
    expect(runner.setTeams).toHaveBeenLastCalledWith([team], crew),
  );
  expect(runner.setSynced).toHaveBeenLastCalledWith({ a: overlay });
  const ada = agentOf(member("a".repeat(64), "Ada"));
  await expect(
    runnerLink.createAgent(ada, { type: "echo", name: "Bo" }),
  ).resolves.toEqual({ requestId: "made", saved: false });
  expect(asks.createAgent).toHaveBeenCalledWith(ada, {
    type: "echo",
    name: "Bo",
  });
  await expect(
    runnerLink.updateAgent(ada, { agent: "Bo", name: "Cy" }),
  ).resolves.toEqual({ requestId: "changed", saved: false });
  await expect(runnerLink.templates(ada)).resolves.toEqual([
    { name: "Team", canvas: "", agents: [] },
  ]);
  await runnerLink.publishType(ada.key, "echo", { reply: "hi" });
  expect(asks.publishType).toHaveBeenCalledWith(ada.key, "echo", {
    reply: "hi",
  });
  runnerLink.finished(ada.key);
  await vi.waitFor(() => expect(asks.finished).toHaveBeenCalledWith(ada.key));
  await manager.resume([ada.key]);
  expect(runner.resumeInterrupted).toHaveBeenCalledWith([ada.key]);
  await manager.dismiss([ada.key]);
  expect(runner.dismissInterrupted).toHaveBeenCalledWith([ada.key]);
});
