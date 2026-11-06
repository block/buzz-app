import { describe, expect, it, vi } from "vitest";
import type { ForwardEvent, ForwardOpened } from "../../features/host/forward";
import type {
  GatewayBinding,
  TurnContext,
} from "../../features/agents/gateway/contract";
import type {
  EligibleRoute,
  GatewayRoute,
} from "../../features/agents/gateway/route";
import {
  type ForwardingHarness,
  GatewayForwarding,
} from "../../features/agents/gateway/forwarding";
import { VECTOR_PROFILE } from "../../features/agents/gateway/vectors";
import {
  type FakeClaude,
  backgroundTasks,
  fakeSpawn,
  flush,
  sessionState,
} from "./claude-testing";
import {
  CHANGED,
  ClaudeForwarding,
  type ForwardNative,
  type Generation,
  HARNESS,
  UNAVAILABLE,
} from "./forwarding";
import {
  AgentSessions,
  type Forward,
  type SavedSession,
  type SessionStore,
} from "./sessions";

const AGENT = "a".repeat(64);
const identity = Object.freeze({
  community_id: "11111111-2222-4333-8444-555555555555",
  human_pubkey: "b".repeat(64),
  agent_pubkey: AGENT,
});
const binding: GatewayBinding = Object.freeze({
  v: 1,
  client_session_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  identity,
});
const context: TurnContext = {
  channel_id: "cccccccc-dddd-4eee-8fff-000000000000",
  message_id: "e".repeat(64),
  thread_id: null,
};
const eligible = (revision: number): EligibleRoute =>
  Object.freeze({
    kind: "eligible",
    revision,
    gatewayOrigin: "https://gateway.example",
    identity,
    profile: VECTOR_PROFILE,
    harnesses: [HARNESS],
  });
const blocked: GatewayRoute = Object.freeze({
  kind: "blocked",
  revision: 3,
  gatewayOrigin: "https://gateway.example",
  reason: "network",
  message: "",
});
const OWNER = { id: "buzz.claude-code", revision: "r1" };

/** A route whose revision the test moves, and a native side that records
 * every call and answers `open` from `answers`. */
function harness(
  answers: ForwardOpened[] = [],
  /** Another harness than Claude, through the shared opener. */
  other?: ForwardingHarness,
) {
  let route: GatewayRoute = eligible(2);
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const events: ((event: ForwardEvent) => void)[] = [];
  const native: ForwardNative = {
    push: vi.fn(async (_owner, key, revision, admits) => {
      calls.push(`push ${key} ${revision} ${admits}`);
      return { type: "applied", revoked: 0 } as const;
    }),
    open: vi.fn(async (_owner, options) => {
      calls.push(`open ${options.route} ${options.routeRevision}`);
      events.push(options.onEvent);
      return (
        answers.shift() ?? {
          type: "opened" as const,
          id: events.length,
          url: `http://127.0.0.1:9/h${events.length}`,
        }
      );
    }),
    associate: vi.fn(
      async (_owner, id, session) =>
        void calls.push(`associate ${id} ${session}`),
    ),
    register: vi.fn(async (_owner, id, call, child) => {
      calls.push(`register ${id} ${call} ${child}`);
      return { type: "registered" } as const;
    }),
    seal: vi.fn(async (_owner, id) => void calls.push(`seal ${id}`)),
    close: vi.fn(async (_owner, id) => {
      calls.push(`close ${id}`);
      events[id - 1]?.({ type: "closed" });
    }),
  };
  const read = vi.fn(() => route);
  const routes = {
    routeFor: read,
    subscribeRoute: (_key: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const forwarding: GatewayForwarding = other
    ? new GatewayForwarding(OWNER, other, native, routes)
    : new ClaudeForwarding(OWNER, native, routes);
  return {
    forwarding,
    native,
    calls,
    read,
    listeners,
    setRoute(next: GatewayRoute) {
      route = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const turn = { binding, context, session: "session-1" };
const signal = new AbortController().signal;

describe("ClaudeForwarding.control", () => {
  it("leaves a control on Claude's own configuration where turns aren't forwarded", () => {
    const h = harness();
    h.setRoute({ kind: "external", revision: 3 });
    expect(h.forwarding.control(AGENT)).toBeUndefined();
    h.setRoute({ ...eligible(4), harnesses: ["codex"] });
    expect(h.forwarding.control(AGENT)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it("gives the route read now, without waiting, where it enables Claude or is blocked", () => {
    const h = harness();
    expect(h.forwarding.control(AGENT)).toEqual(eligible(2));
    h.setRoute(blocked);
    expect(h.forwarding.control(AGENT)).toEqual(blocked);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.calls).toEqual([]);
  });
});

describe("ClaudeForwarding.open", () => {
  it("pushes the dispatched revision, then opens at it with the turn's frozen headers", async () => {
    const { forwarding, native, calls } = harness();
    const generation = await forwarding.open(AGENT, eligible(2), turn, signal);
    expect(generation.url).toBe("http://127.0.0.1:9/h1");
    expect(calls).toEqual(["push route-1 2 true", "open route-1 2"]);
    const [, options] = nth(vi.mocked(native.open).mock.calls);
    expect(options).toMatchObject({ harness: "claude", session: "session-1" });
    const { headers } = VECTOR_PROFILE;
    expect(options.inference[headers.message_id]).toBe(context.message_id);
    expect(options.inference[headers.launcher_session]).toBe(
      binding.client_session_id,
    );
    expect(options.discovery[headers.message_id]).toBeUndefined();
  });

  it("fails on a refusal, without re-reading the route or opening again", async () => {
    const h = harness([{ type: "refused", current: 3, admits: true }]);
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(h.native.open).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it("fails, opening nothing, when the route moved past the dispatched revision", async () => {
    const h = harness();
    h.setRoute(eligible(3));
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    h.setRoute(blocked);
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(h.native.open).not.toHaveBeenCalled();
  });

  it("never opens once the route moved during the push", async () => {
    const h = harness();
    vi.mocked(h.native.push).mockImplementationOnce(async () => {
      h.setRoute(eligible(3));
      return { type: "applied", revoked: 0 };
    });
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(h.native.open).not.toHaveBeenCalled();
  });

  it("fails for a binding the route no longer admits", async () => {
    const h = harness();
    const other = {
      ...binding,
      identity: { ...identity, human_pubkey: "f".repeat(64) },
    };
    await expect(
      h.forwarding.open(
        AGENT,
        eligible(2),
        { ...turn, binding: other },
        signal,
      ),
    ).rejects.toThrow(CHANGED);
    expect(h.calls).toEqual([]);
  });

  it("records a route change after opening, for an owner that attaches later", async () => {
    const h = harness();
    const generation = await h.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    h.setRoute(eligible(2)); // the same revision: nothing changed
    expect(generation.isRevoked()).toBe(false);
    h.setRoute(eligible(3));
    expect(h.calls.at(-1)).toBe("push route-1 3 true");
    expect(generation.isRevoked()).toBe(true);
    const revoked = vi.fn();
    await generation.revoked.then(revoked);
    expect(revoked).toHaveBeenCalledTimes(1);
    // Closing stops listening, and resolves on native `closed`.
    await generation.close();
    h.setRoute(eligible(4));
    expect(h.calls.at(-1)).toBe("close 1");
  });

  it("pushes a change made during the native open, closes what opened, and fails", async () => {
    const h = harness();
    const open = h.native.open;
    const opening = vi.mocked(open).getMockImplementation();
    vi.mocked(open).mockImplementationOnce(async (owner, options) => {
      const answer = await opening?.(owner, options);
      h.setRoute(blocked); // while native open is still pending
      return answer as never;
    });
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(h.calls).toEqual([
      "push route-1 2 true",
      "open route-1 2",
      "push route-1 3 false",
      "close 1",
    ]);
  });

  it("closes a generation that opens after the turn was cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const open = vi.mocked(h.native.open);
    const opening = open.getMockImplementation();
    open.mockImplementationOnce(async (owner, options) => {
      await held;
      return opening?.(owner, options) as never;
    });
    const result = h.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      controller.signal,
    );
    await flush();
    controller.abort(new Error("cancelled"));
    answer();
    await expect(result).rejects.toThrow("cancelled");
    expect(h.calls).toEqual([
      "push route-1 2 true",
      "open route-1 2",
      "close 1",
    ]);
  });

  it("still fails with the cancellation when native could not close what opened after it", async () => {
    const h = harness();
    const controller = new AbortController();
    vi.mocked(h.native.open).mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return { type: "opened", id: 1, url: "http://127.0.0.1:9/h1" };
    });
    vi.mocked(h.native.close).mockRejectedValueOnce(new Error("gone"));
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(h.native.close).toHaveBeenCalledOnce();
  });

  it("fails before dispatch when native forwarding can't be reached", async () => {
    for (const method of ["push", "open"] as const) {
      const h = harness();
      vi.mocked(h.native[method]).mockRejectedValueOnce(new Error("no grant"));
      await expect(
        h.forwarding.open(AGENT, eligible(2), turn, signal),
      ).rejects.toThrow(UNAVAILABLE);
      expect(h.native.open).toHaveBeenCalledTimes(method === "push" ? 0 : 1);
      expect(h.listeners.size).toBe(0);
    }
  });

  it("seals once and never after closing; a close native refused rejects, every time", async () => {
    const h = harness();
    const generation = await h.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    generation.seal();
    generation.seal();
    vi.mocked(h.native.close).mockRejectedValueOnce(new Error("gone"));
    await expect(generation.close()).rejects.toThrow("gone");
    await expect(generation.close()).rejects.toThrow("gone");
    expect(h.native.close).toHaveBeenCalledOnce();
    generation.seal();
    expect(h.calls.filter((call) => call.startsWith("seal"))).toEqual([
      "seal 1",
    ]);
  });
});

describe("GatewayForwarding for goose", () => {
  const GOOSE = { upstream: "goose", native: "goose" } as const;

  it("enables the harness it declares, and opens with no session", async () => {
    const h = harness([], GOOSE);
    expect(h.forwarding.control(AGENT)).toBeUndefined();
    h.setRoute({ ...eligible(2), harnesses: ["goose"] });
    expect(h.forwarding.control(AGENT)).toEqual({
      ...eligible(2),
      harnesses: ["goose"],
    });
    await h.forwarding.open(AGENT, eligible(2), { binding, context }, signal);
    const [, options] = nth(vi.mocked(h.native.open).mock.calls);
    expect(options.harness).toBe("goose");
    expect(options).not.toHaveProperty("session");
  });

  it("names its session and registers children on its own generation", async () => {
    const h = harness([], GOOSE);
    await h.forwarding.open(AGENT, eligible(2), { binding, context }, signal);
    const generation = await h.forwarding.open(
      AGENT,
      eligible(2),
      { binding, context },
      signal,
    );
    await generation.associate("goose-session");
    await expect(
      generation.registerChild("call-1", "child-1"),
    ).resolves.toEqual({ type: "registered" });
    expect(h.calls.slice(-2)).toEqual([
      "associate 2 goose-session",
      "register 2 call-1 child-1",
    ]);
    expect(vi.mocked(h.native.associate).mock.calls[0]?.[0]).toBe(OWNER);
  });
});

/** A generation that records seal and close, for the process lifecycle;
 * `revoke` moves its route on, and `closed` holds native `closed`. */
function generation(
  name: string,
  log: string[],
  closed: Promise<void> = Promise.resolve(),
) {
  let closing: Promise<void> | undefined;
  let sealed = false;
  let revoked = false;
  let revoke!: () => void;
  const revocation = new Promise<void>((resolve) => {
    revoke = () => {
      revoked = true;
      resolve();
    };
  });
  const value: Generation = {
    url: `http://127.0.0.1:9/${name}`,
    revoked: revocation,
    isRevoked: () => revoked,
    seal: () => {
      if (!sealed) log.push(`seal ${name}`);
      sealed = true;
    },
    close: () => {
      closing ??= Promise.resolve()
        .then(() => void log.push(`close ${name}`))
        .then(() => closed)
        .then(() => void log.push(`closed ${name}`));
      return closing;
    },
    associate: async () => {},
    registerChild: async () => ({ type: "registered" }),
  };
  return Object.assign(value, { revoke });
}

function pool(
  failure?: (session: string) => string,
  fingerprint: () => string = () => "same",
  spawned: (process: FakeClaude) => void = () => {},
) {
  const fake = fakeSpawn(new Set(), failure);
  const all = new Map<string, SavedSession>();
  const store: SessionStore = {
    get: (key) => all.get(key),
    set: (key, session) => void all.set(key, session),
    delete: (key) => void all.delete(key),
  };
  let ids = 0;
  const sessions = new AgentSessions({
    spawn: (id, options) => {
      const process = fake.spawn(id, options);
      const started = fake.processes.at(-1);
      if (started) {
        started.hold = true;
        spawned(started);
      }
      return process;
    },
    store,
    launch: async () => ({ cwd: "/work", systemPrompt: "prompt" }),
    fingerprint,
    newId: () => `new-${++ids}`,
  });
  const log: string[] = [];
  const opened: [string, unknown][] = [];
  const forward: Forward = async (session, saved) => {
    opened.push([session, saved]);
    log.push(`open g${opened.length}`);
    // As `bindSession` does: a saved binding is kept, else one is minted.
    return {
      generation: generation(`g${opened.length}`, log),
      binding: (saved as GatewayBinding | undefined) ?? binding,
    };
  };
  const claudes = () => fake.processes.filter(({ id }) => id === "claude");
  return { sessions, all, log, opened, forward, claudes, known: fake.known };
}
/** The `n`th Claude process started, failing the test when there is none. */
function nth<T>(items: readonly T[], n = 0): T {
  const item = items[n];
  if (item === undefined) throw new Error(`no item ${n}`);
  return item;
}
const settingsOf = (process: { options: { args?: readonly string[] } }) => {
  const args = process.options.args ?? [];
  const index = args.indexOf("--settings");
  return index < 0 ? undefined : args[index + 1];
};

const isInterrupt = (message: Record<string, unknown>) =>
  message.type === "control_request" &&
  (message.request as { subtype?: string }).subtype === "interrupt";

describe("forwarded turns in a conversation", () => {
  it("keeps admission open through background work and its self-turn, sealing at the qualifying idle", async () => {
    const { sessions, log, forward, claudes } = pool();
    const delivered = sessions.deliver("c", "hi", 1, { forward });
    await flush();
    const process = nth(claudes());
    expect(settingsOf(process)).toBe(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/g1" } }),
    );
    expect(process.options.args).toEqual(
      expect.arrayContaining(["--session-id", "new-1"]),
    );
    // A background task starts, then the turn's result and idle arrive.
    backgroundTasks(process, {});
    process.finish();
    expect(await delivered).toEqual({ ok: true });
    await flush();
    expect(log).toEqual(["open g1"]);
    // The task finishing is not the end: its completion starts a turn.
    backgroundTasks(process);
    await flush();
    expect(log).toEqual(["open g1"]);
    sessionState(process, "running");
    await flush();
    expect(log).toEqual(["open g1"]);
    sessionState(process, "idle");
    await flush();
    expect(log).toEqual(["open g1", "seal g1", "close g1", "closed g1"]);
    expect(process.killed).toBe(true);
  });

  it("gives a message sent mid-turn its own generation, never the busy process", async () => {
    const { sessions, log, opened, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    const second = sessions.deliver("c", "two", 2, {
      forward,
      steer: "steer: two",
    });
    await flush();
    const process = nth(claudes());
    expect(process.prompts).toEqual(["one"]);
    expect(opened).toHaveLength(1);
    process.finish();
    await first;
    await flush();
    expect(log).toEqual([
      "open g1",
      "seal g1",
      "close g1",
      "closed g1",
      "open g2",
    ]);
    const next = nth(claudes(), 1);
    expect(next.prompts).toEqual(["two"]);
    expect(settingsOf(next)).toContain("/g2");
    next.finish();
    expect(await second).toEqual({ ok: true });
  });

  it("keeps the next turn out until the last process has exited and native has closed", async () => {
    const { sessions, log, forward, claudes } = pool();
    let closed!: () => void;
    const held = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const first = sessions.deliver("c", "one", 1, {
      forward: async () => {
        log.push("open held");
        return { generation: generation("held", log, held), binding };
      },
    });
    await flush();
    const process = nth(claudes());
    process.exitOnKill = false;
    process.finish();
    await first;
    await flush();
    // Sealed and asked to stop, but still running: activity resumes.
    expect(process.killed).toBe(true);
    sessionState(process, "running");
    sessionState(process, "idle");
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(log).toEqual(["open held", "seal held"]);
    expect(claudes()).toHaveLength(1);
    process.exit(null);
    await flush();
    expect(log).toEqual(["open held", "seal held", "close held"]);
    expect(claudes()).toHaveLength(1);
    closed();
    await flush();
    expect(log).toEqual([
      "open held",
      "seal held",
      "close held",
      "closed held",
      "open g1",
    ]);
    nth(claudes(), 1).finish();
    await second;
  });

  it("lets the next turn in when native could not close the last generation", async () => {
    const { sessions, log, forward, claudes } = pool();
    let refuse!: (error: Error) => void;
    const refused = new Promise<void>((_, reject) => {
      refuse = reject;
    });
    const first = sessions.deliver("c", "one", 1, {
      forward: async () => {
        log.push("open refused");
        return { generation: generation("refused", log, refused), binding };
      },
    });
    await flush();
    nth(claudes()).finish();
    await first;
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    refuse(new Error("gone"));
    await flush();
    expect(log).toEqual([
      "open refused",
      "seal refused",
      "close refused",
      "open g1",
    ]);
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("restarts on settings saved during startup only once the first process has exited", async () => {
    // Read before launch, then changed by the time the process is up.
    let reads = 0;
    const { sessions, log, forward, claudes } = pool(
      undefined,
      () => (reads++ === 0 ? "old" : "new"),
      (process) => {
        process.exitOnKill = false;
      },
    );
    const delivered = sessions.deliver("c", "hi", 1, { forward });
    await flush();
    const first = nth(claudes());
    expect(first.killed).toBe(true);
    expect(claudes()).toHaveLength(1);
    first.exit(null);
    await flush();
    const second = nth(claudes(), 1);
    expect(settingsOf(second)).toContain("/g1");
    expect(second.options.args).toEqual(
      expect.arrayContaining(["--session-id", "new-1"]),
    );
    second.exitOnKill = true;
    second.finish();
    expect(await delivered).toEqual({ ok: true });
    await flush();
    expect(log).toEqual(["open g1", "seal g1", "close g1", "closed g1"]);
  });

  it("resumes the next turn in a new process on the same sessions", async () => {
    const { sessions, all, opened, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    nth(claudes()).finish();
    await first;
    await flush();
    expect(all.get("c")).toMatchObject({ id: "new-1", gateway: binding });
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(opened).toEqual([
      ["new-1", undefined],
      ["new-1", binding],
    ]);
    const next = nth(claudes(), 1);
    expect(next.options.args).toEqual(
      expect.arrayContaining(["--resume", "new-1"]),
    );
    next.finish();
    await second;
  });

  it("holds a message and an interrupt sent while the generation opens", async () => {
    const { sessions, log, forward, claudes } = pool();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Forward = async (session, saved) => {
      await gate;
      return forward(session, saved);
    };
    const first = sessions.deliver("c", "one", 1, { forward: slow });
    const second = sessions.deliver("c", "two", 2, { forward: slow });
    const stopped = sessions.interrupt("c");
    await flush();
    expect(claudes()).toHaveLength(0);
    release();
    await stopped;
    await flush();
    expect(log).toEqual(["open g1"]);
    const process = nth(claudes());
    expect(process.prompts).toEqual(["one"]);
    expect(process.received.filter(isInterrupt)).toHaveLength(1);
    process.finish();
    await first;
    await flush();
    expect(nth(claudes(), 1).prompts).toEqual(["two"]);
    nth(claudes(), 1).finish();
    await second;
  });

  it("fails a turn whose generation could not open before spawning anything", async () => {
    const { sessions, claudes } = pool();
    const result = await sessions.deliver("c", "hi", 1, {
      forward: async () => {
        throw new Error(
          "This conversation's saved Buzz session is unreadable.",
        );
      },
    });
    expect(result).toEqual({
      ok: false,
      error: "This conversation's saved Buzz session is unreadable.",
      undelivered: true,
    });
    expect(claudes()).toHaveLength(0);
    // Nothing opened, so nothing holds the conversation.
    const next = sessions.deliver("c", "again", 2);
    await flush();
    nth(claudes()).finish();
    expect(await next).toEqual({ ok: true });
  });

  it("lets an ordinary process's background work and its completion turn end at Claude's idle, and the process exit, before a forwarded turn", async () => {
    const { sessions, log, forward, claudes } = pool(
      undefined,
      undefined,
      (process) => {
        process.exitOnKill = false;
      },
    );
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    backgroundTasks(process, {});
    process.finish();
    await first;
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(process.killed).toBe(false);
    // The task ending is not the end: Claude may still start a turn on it.
    backgroundTasks(process);
    await flush();
    expect(process.killed).toBe(false);
    sessionState(process, "running");
    await flush();
    expect(process.killed).toBe(false);
    expect(log).toEqual([]);
    sessionState(process, "idle");
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual([]);
    process.exit(null);
    await flush();
    expect(log).toEqual(["open g1"]);
    const next = nth(claudes(), 1);
    next.exitOnKill = true;
    expect(next.prompts).toEqual(["two"]);
    next.finish();
    expect(await second).toEqual({ ok: true });
  });

  it("waits for Claude's idle when background work ended before the forwarded message came", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    backgroundTasks(process, {});
    process.finish();
    await first;
    // No longer active, yet Claude hasn't said it is idle since.
    backgroundTasks(process);
    await flush();
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(process.killed).toBe(false);
    sessionState(process, "running");
    await flush();
    expect(process.killed).toBe(false);
    sessionState(process, "idle");
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open g1"]);
    const next = nth(claudes(), 1);
    expect(next.prompts).toEqual(["two"]);
    next.finish();
    expect(await second).toEqual({ ok: true });
  });

  it("waits for Claude's idle again after background work starts past it", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    process.finish();
    await first;
    backgroundTasks(process, {});
    backgroundTasks(process);
    await flush();
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(process.killed).toBe(false);
    sessionState(process, "idle");
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open g1"]);
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("lets an ordinary turn sent past Claude's idle end before a forwarded turn", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    process.finish();
    await first;
    const second = sessions.deliver("c", "two", 2);
    await flush();
    expect(process.prompts).toEqual(["one", "two"]);
    const third = sessions.deliver("c", "three", 3, { forward });
    await flush();
    expect(process.killed).toBe(false);
    process.finish();
    expect(await second).toEqual({ ok: true });
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open g1"]);
    nth(claudes(), 1).finish();
    expect(await third).toEqual({ ok: true });
  });

  it("keeps waiting when Claude reports activity in the same output as its idle", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    backgroundTasks(process, {});
    process.finish();
    await first;
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    backgroundTasks(process);
    // One stdout batch: both lines are handled before the waiter resumes.
    sessionState(process, "idle");
    sessionState(process, "running");
    await flush();
    expect(process.killed).toBe(false);
    expect(log).toEqual([]);
    sessionState(process, "idle");
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open g1"]);
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("stops waiting for Claude's idle once the ordinary process exits", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    backgroundTasks(process, {});
    process.finish();
    await first;
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    process.exit(1);
    await flush();
    expect(log).toEqual(["open g1"]);
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("stops an ordinary process already at Claude's idle for a forwarded turn at once", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    process.finish();
    await first;
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open g1"]);
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("keeps an ordinary process running past a background task's end while nothing forwarded waits", async () => {
    const { sessions, claudes } = pool();
    const first = sessions.deliver("c", "one", 1);
    await flush();
    const process = nth(claudes());
    backgroundTasks(process, {});
    process.finish();
    await first;
    backgroundTasks(process);
    sessionState(process, "idle");
    await flush();
    expect(process.killed).toBe(false);
    const second = sessions.deliver("c", "two", 2);
    await flush();
    expect(process.prompts).toEqual(["one", "two"]);
    process.finish();
    expect(await second).toEqual({ ok: true });
  });

  it("starts an unforwarded message only after the forwarded turn's process has ended", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    const second = sessions.deliver("c", "two", 2, { steer: "steer: two" });
    await flush();
    expect(nth(claudes()).prompts).toEqual(["one"]);
    nth(claudes()).finish();
    await first;
    await flush();
    expect(log).toEqual(["open g1", "seal g1", "close g1", "closed g1"]);
    const next = nth(claudes(), 1);
    expect(settingsOf(next)).toBeUndefined();
    expect(next.prompts).toEqual(["two"]);
    next.finish();
    await second;
  });

  it("opens anew when the route moved on before the first prompt, sending nothing to the old process", async () => {
    const { sessions, log, claudes } = pool();
    const generations = [generation("g1", log), generation("g2", log)];
    nth(generations).revoke(); // before any owner attached
    let n = 0;
    const delivered = sessions.deliver("c", "hi", 1, {
      forward: async () => ({ generation: nth(generations, n++), binding }),
    });
    await flush();
    const [old, next] = claudes();
    expect(old?.prompts).toEqual([]);
    expect(old?.killed).toBe(true);
    expect(next?.prompts).toEqual(["hi"]);
    expect(settingsOf(nth(claudes(), 1))).toContain("/g2");
    // Its session was never written, so the new one doesn't resume it.
    expect(next?.options.args).toEqual(
      expect.arrayContaining(["--session-id", "new-2"]),
    );
    expect(log).toEqual(["close g1", "closed g1"]);
    next?.finish();
    expect(await delivered).toEqual({ ok: true });
  });

  it("checks revocation again just before the first prompt, after the last wait", async () => {
    const { sessions, log, claudes } = pool();
    const generations = [generation("g1", log), generation("g2", log)];
    let n = 0;
    const delivered = sessions.deliver("c", "hi", 1, {
      forward: async () => ({ generation: nth(generations, n++), binding }),
      // Revoked after this wait's continuation is queued, before the drop
      // the revocation schedules has run.
      admit: () => {
        if (n === 1) queueMicrotask(() => nth(generations).revoke());
        return Promise.resolve();
      },
    });
    await flush();
    await flush();
    const [old, next] = claudes();
    expect(old?.prompts).toEqual([]);
    expect(next?.prompts).toEqual(["hi"]);
    next?.finish();
    expect(await delivered).toEqual({ ok: true });
  });

  it("ends the process when the route revokes its generation mid-turn, failing the turn visibly", async () => {
    const { sessions, log, claudes } = pool();
    const g = generation("g1", log);
    const delivered = sessions.deliver("c", "hi", 1, {
      forward: async () => ({ generation: g, binding }),
    });
    await flush();
    g.revoke();
    expect(await delivered).toMatchObject({ ok: false });
    await flush();
    expect(nth(claudes()).killed).toBe(true);
    expect(log).toEqual(["close g1", "closed g1"]);
  });

  it("starts over on a new session and binding only when Claude says the saved one is gone", async () => {
    const { sessions, all, log, opened, forward, claudes } = pool(
      (session) => `No conversation found with session ID: ${session}`,
    );
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "lost", seen: 4, at: 1, gateway: saved });
    const delivered = sessions.deliver("c", "hello", 9, {
      forward,
      fresh: async () => "hello, with the thread so far",
    });
    await flush();
    const [failed, fresh] = claudes();
    expect(failed?.options.args).toEqual(
      expect.arrayContaining(["--resume", "lost"]),
    );
    expect(opened).toEqual([
      ["lost", saved],
      ["new-1", undefined],
    ]);
    // The old generation is closed before the new one opens.
    expect(log).toEqual(["open g1", "close g1", "closed g1", "open g2"]);
    expect(fresh?.options.args).toEqual(
      expect.arrayContaining(["--session-id", "new-1"]),
    );
    expect(settingsOf(nth(claudes(), 1))).toContain("/g2");
    fresh?.finish();
    expect(await delivered).toEqual({ ok: true });
    expect(all.get("c")).toMatchObject({ id: "new-1", gateway: binding });
  });

  it.each([
    ["auth", () => "Invalid API key · Please run /login"],
    ["network", () => "API Error: Connection error."],
  ])(
    "keeps the saved session and binding when a resume fails on %s, replaying nothing",
    async (_, failure) => {
      const { sessions, all, opened, forward, claudes } = pool(failure);
      const saved = { v: 1, client_session_id: "old", identity };
      all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
      const delivered = sessions.deliver("c", "hello", 9, {
        forward,
        fresh: async () => "hello, with the thread so far",
      });
      expect(await delivered).toMatchObject({ ok: false });
      expect(claudes()).toHaveLength(1);
      expect(opened).toEqual([["kept", saved]]);
      expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
    },
  );

  it("compacts a conversation once bound to the gateway on Claude's own configuration, keeping its binding", async () => {
    const { sessions, all, claudes, known } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    known.add("kept");
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    const compacted = sessions.compact("c");
    await flush();
    const process = nth(claudes());
    expect(settingsOf(process)).toBeUndefined();
    expect(process.prompts).toEqual(["/compact"]);
    process.finish();
    expect(await compacted).toEqual({ ok: true });
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("keeps a bound conversation's session and binding when compaction fails on auth", async () => {
    const { sessions, all, claudes } = pool(
      () => "Invalid API key · Please run /login",
    );
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    expect(await sessions.compact("c")).toMatchObject({ ok: false });
    expect(claudes()).toHaveLength(1);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("forgets a bound conversation's session when compaction finds Claude no longer has it", async () => {
    const { sessions, all } = pool(
      (session) => `No conversation found with session ID: ${session}`,
    );
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "lost", seen: 4, at: 1, gateway: saved });
    expect(await sessions.compact("c")).toEqual({ ok: true });
    expect(all.get("c")).toBeUndefined();
  });

  it("compacts through a generation of its own on the saved session, keeping later turns out until native closes", async () => {
    const { sessions, all, log, claudes, known, forward } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    known.add("kept");
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    let closed!: () => void;
    const held = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const sessionsAsked: [string, unknown][] = [];
    const compacted = sessions.compact("c", async (session, prior) => {
      sessionsAsked.push([session, prior]);
      log.push("open held");
      return {
        generation: generation("held", log, held),
        binding: saved as GatewayBinding,
      };
    });
    await flush();
    const process = nth(claudes());
    expect(sessionsAsked).toEqual([["kept", saved]]);
    expect(settingsOf(process)).toContain("http://127.0.0.1:9/held");
    expect(process.prompts).toEqual(["/compact"]);
    process.finish();
    expect(await compacted).toEqual({ ok: true });
    await flush();
    expect(process.killed).toBe(true);
    expect(log).toEqual(["open held", "seal held", "close held"]);
    // Its binding and history watermark are the conversation's, unchanged.
    expect(all.get("c")).toMatchObject({
      id: "kept",
      seen: 4,
      gateway: saved,
    });
    // The control has settled; native hasn't closed, so nothing enters.
    const next = sessions.deliver("c", "two", 5, { forward });
    await flush();
    expect(claudes()).toHaveLength(1);
    closed();
    await flush();
    expect(log.slice(3)).toEqual(["closed held", "open g1"]);
    nth(claudes(), 1).finish();
    expect(await next).toEqual({ ok: true });
  });

  it("forgets a session Claude no longer has instead of compacting a new one", async () => {
    const { sessions, all, opened, claudes, forward } = pool(
      (session) => `No conversation found with session ID: ${session}`,
    );
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "lost", seen: 4, at: 1, gateway: saved });
    expect(await sessions.compact("c", forward)).toEqual({ ok: true });
    await flush();
    expect(opened).toEqual([["lost", saved]]);
    expect(claudes()).toHaveLength(1);
    expect(all.get("c")).toBeUndefined();
  });

  it("keeps the saved session and binding when a forwarded compaction fails on auth", async () => {
    const { sessions, all, opened, claudes, forward } = pool(
      () => "Invalid API key · Please run /login",
    );
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    expect(await sessions.compact("c", forward)).toMatchObject({ ok: false });
    await flush();
    expect(opened).toEqual([["kept", saved]]);
    expect(claudes()).toHaveLength(1);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("opens nothing to compact a conversation with no session", async () => {
    const { sessions, opened, claudes, forward } = pool();
    expect(await sessions.compact("c", forward)).toEqual({ ok: true });
    expect(opened).toEqual([]);
    expect(claudes()).toHaveLength(0);
  });

  it("fails a forwarded compaction whose generation can't open, spawning nothing", async () => {
    const { sessions, all, claudes } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    expect(
      await sessions.compact("c", async () => {
        throw new Error("Couldn't compact through the gateway");
      }),
    ).toMatchObject({
      ok: false,
      error: "Couldn't compact through the gateway",
    });
    expect(claudes()).toHaveLength(0);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("sends a cancelled compaction nothing once its process is up, closing its generation", async () => {
    const { sessions, all, log, claudes, known, forward } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    known.add("kept");
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    let live = true;
    const compacted = sessions.compact("c", forward, () => live);
    live = false;
    expect(await compacted).toMatchObject({ ok: true, undelivered: true });
    await flush();
    expect(nth(claudes()).prompts).toEqual([]);
    expect(nth(claudes()).killed).toBe(true);
    expect(log).toEqual(["open g1", "close g1", "closed g1"]);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("ends a compaction whose route revokes its generation, keeping the session", async () => {
    const { sessions, all, log, claudes, known } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    known.add("kept");
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    const g = generation("g1", log);
    const compacted = sessions.compact("c", async () => ({
      generation: g,
      binding: saved as GatewayBinding,
    }));
    await flush();
    expect(nth(claudes()).prompts).toEqual(["/compact"]);
    g.revoke();
    expect(await compacted).toMatchObject({ ok: false });
    await flush();
    expect(nth(claudes()).killed).toBe(true);
    expect(log).toEqual(["close g1", "closed g1"]);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("keeps the saved session and binding when Claude fails to start", async () => {
    const { sessions, all, opened, forward } = pool();
    const saved = { v: 1, client_session_id: "old", identity };
    all.set("c", { id: "kept", seen: 4, at: 1, gateway: saved });
    const broken = new AgentSessions({
      spawn: async () => {
        throw new Error("spawn failed");
      },
      store: {
        get: (key) => all.get(key),
        set: (key, session) => void all.set(key, session),
        delete: (key) => void all.delete(key),
      },
      launch: async () => ({ cwd: "/work", systemPrompt: "prompt" }),
      fingerprint: () => "same",
    });
    void sessions;
    expect(await broken.deliver("c", "hello", 9, { forward })).toMatchObject({
      ok: false,
      undelivered: true,
    });
    expect(opened).toEqual([["kept", saved]]);
    expect(all.get("c")).toMatchObject({ id: "kept", gateway: saved });
  });

  it("closes every generation when the agent's sessions are disposed", async () => {
    const { sessions, log, forward } = pool();
    const delivered = sessions.deliver("c", "hi", 1, { forward });
    await flush();
    await sessions.shutdown();
    await delivered;
    await flush();
    expect(log).toEqual(["open g1", "close g1", "closed g1"]);
  });

  it("runs a one-off turn on its own generation, unsaved, sealing at idle", async () => {
    const { sessions, log, opened, forward, claudes, all } = pool();
    const done = sessions.runOnce("watch", () => "wake", undefined, forward);
    await flush();
    const process = nth(claudes());
    expect(settingsOf(process)).toContain("/g1");
    process.finish();
    expect(await done).toEqual({ ok: true });
    expect(opened).toEqual([["new-1", undefined]]);
    expect(log).toEqual(["open g1", "seal g1", "close g1", "closed g1"]);
    expect(all.size).toBe(0);
  });

  it("ends a one-off turn as it did when native could not close its generation", async () => {
    const { sessions, log, claudes } = pool();
    const refused = Promise.reject(new Error("gone"));
    refused.catch(() => undefined);
    const done = sessions.runOnce(
      "watch",
      () => "wake",
      undefined,
      async () => ({
        generation: generation("refused", log, refused),
        binding,
      }),
    );
    await flush();
    nth(claudes()).finish();
    expect(await done).toEqual({ ok: true });
    expect(log).toEqual(["seal refused", "close refused"]);
  });

  it("ends a one-off turn's process when the route revokes its generation", async () => {
    const { sessions, log, claudes } = pool();
    const g = generation("g1", log);
    const done = sessions.runOnce(
      "watch",
      () => "wake",
      undefined,
      async () => ({
        generation: g,
        binding,
      }),
    );
    await flush();
    g.revoke();
    expect(await done).toMatchObject({ ok: false });
    expect(nth(claudes()).killed).toBe(true);
    expect(log).toEqual(["close g1", "closed g1"]);
  });

  it("sends a one-off turn nothing once its route moved on during startup", async () => {
    const { sessions, log, claudes } = pool();
    const g = generation("g1", log);
    g.revoke();
    const done = sessions.runOnce(
      "watch",
      () => "wake",
      undefined,
      async () => ({
        generation: g,
        binding,
      }),
    );
    expect(await done).toMatchObject({ ok: false });
    expect(nth(claudes()).prompts).toEqual([]);
    expect(log).toEqual(["close g1", "closed g1"]);
  });

  it("checks a one-off turn's revocation again just before its prompt", async () => {
    const { sessions, log, claudes } = pool();
    const g = generation("g1", log);
    const done = sessions.runOnce(
      "watch",
      () => {
        queueMicrotask(() => g.revoke());
        return "wake";
      },
      undefined,
      async () => ({ generation: g, binding }),
    );
    expect(await done).toEqual({
      ok: false,
      error: "This agent's gateway access changed before the turn could start.",
    });
    expect(nth(claudes()).prompts).toEqual([]);
  });

  it("closes a one-off turn's generation that opens after it was cancelled, spawning nothing", async () => {
    const { sessions, log, claudes } = pool();
    const controller = new AbortController();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const done = sessions.runOnce(
      "watch",
      () => "wake",
      controller.signal,
      async () => {
        await held;
        return { generation: generation("g1", log), binding };
      },
    );
    controller.abort(new Error("cancelled"));
    answer();
    expect(await done).toEqual({ ok: false, error: "cancelled" });
    expect(claudes()).toHaveLength(0);
    expect(log).toEqual(["close g1", "closed g1"]);
  });

  it("fails a one-off turn whose generation can't open with its reason, spawning nothing", async () => {
    const { sessions, claudes } = pool();
    const done = sessions.runOnce(
      "watch",
      () => "wake",
      undefined,
      async () => {
        throw new Error(CHANGED);
      },
    );
    expect(await done).toEqual({ ok: false, error: CHANGED });
    expect(claudes()).toHaveLength(0);
  });
});
