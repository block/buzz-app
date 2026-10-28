import { afterEach, expect, it, vi } from "vitest";
import { link, type Link, type LinkPort } from "./link";
import { createLocalAgentActivity } from "./local-activity";
import { agentKey } from "./membership";
import type { RunnerStatus } from "./agents-runner";
import { blank, type Member, type RecordEdit } from "./records";
import {
  linkedActivity,
  managerSide,
  runnerSide,
  serveActivity,
} from "./runner-link";
import type { Agent, SessionControlAction, SessionPlace } from "./service";
import type { AgentRecord } from "./store";

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
    // Saves the config, and the type it is shown with, at once.
    retype: vi.fn(async (key: string, type: string, config: unknown) => {
      await Promise.resolve();
      saved = { ...saved, [key]: { ...(saved[key] ?? blank(key)), config } };
      types = { ...types, [key]: type };
      for (const listener of [...recordListeners]) listener();
    }),
    retypes: () => types,
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
  const manager = managerSide(channel.port2, {
    members: () => ({ loaded: true, identities: shown, viewer: owner }),
    defaults,
    retyped: (types) => retyped(types),
    changed,
  });
  open.push(runnerLink);
  closing.push(manager);
  return {
    runner,
    left,
    manager,
    changed,
    retyped,
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
      }),
      defaults: () => undefined,
      retyped: () => {},
      changed: () => {},
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
  await manager.retype(ada.key, "example/other", { reply: "other" });
  expect(runner.retype).toHaveBeenCalledWith(ada.key, "example/other", {
    reply: "other",
  });
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
