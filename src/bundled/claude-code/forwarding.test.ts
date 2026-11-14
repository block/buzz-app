import { describe, expect, it, vi } from "vitest";
import type { ForwardEvent, ForwardOpened } from "../../features/host/forward";
import type { HostProcess } from "../../features/host/service";
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
import { forwardEnv } from "./claude";
import {
  BYPASSED,
  CHANGED,
  ClaudeForwarding,
  type ForwardNative,
  type ForwardRetry,
  type Generation,
  HARNESS,
  type Inherited,
  MANAGED_UNREADABLE,
  managedRefusal,
  managedRouting,
  NO_PROXY_UNREADABLE,
  noProxy,
  UNAVAILABLE,
  UNREACHED,
} from "./forwarding";
const UNREACHABLE = "Could not start forwarding";
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
  retry: ForwardRetry = { delays: [] },
  managed: () => Promise<readonly string[]> = async () => [],
  inherited: () => Promise<Inherited> = async () => ({
    lists: ["", ""],
    proxied: false,
  }),
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
  const setRoute = (next: GatewayRoute) => {
    route = next;
    for (const listener of [...listeners]) listener();
  };
  const routes = {
    routeFor: read,
    subscribeRoute: (_key: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // As the app's routes do: only the current revision's access drops.
    invalidateRoute: vi.fn((_key: string, revision?: number) => {
      if (revision === route.revision)
        setRoute({ ...route, revision: route.revision + 1 } as GatewayRoute);
    }),
  };
  const forwarding: GatewayForwarding = other
    ? new GatewayForwarding(OWNER, other, inherited, native, routes, retry)
    : new ClaudeForwarding(OWNER, managed, inherited, native, routes, retry);
  return {
    forwarding,
    native,
    calls,
    read,
    listeners,
    routes,
    events,
    setRoute,
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

describe("managedRouting", () => {
  const settings = (env: Record<string, unknown>) => JSON.stringify({ env });

  it("names a provider managed settings turn on, as Claude reads one", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on"])
      expect(
        managedRouting([settings({ CLAUDE_CODE_USE_BEDROCK: on })], false),
      ).toBe("CLAUDE_CODE_USE_BEDROCK");
    for (const off of ["0", "", "false", "no"])
      expect(
        managedRouting([settings({ CLAUDE_CODE_USE_VERTEX: off })], false),
      ).toBeUndefined();
  });

  it("names an endpoint managed settings set, and a provider before it", () => {
    expect(
      managedRouting(
        [settings({ ANTHROPIC_VERTEX_BASE_URL: "https://v" })],
        false,
      ),
    ).toBe("ANTHROPIC_VERTEX_BASE_URL");
    expect(
      managedRouting([settings({ CLAUDE_CODE_API_BASE_URL: " " })], false),
    ).toBeUndefined();
    expect(
      managedRouting(
        [
          settings({
            ANTHROPIC_BASE_URL: "https://proxy",
            CLAUDE_CODE_USE_FOUNDRY: "1",
          }),
        ],
        false,
      ),
    ).toBe("CLAUDE_CODE_USE_FOUNDRY");
  });

  it("merges files in order, a later one overriding, and skips what isn't settings", () => {
    expect(
      managedRouting(
        [
          settings({ CLAUDE_CODE_USE_BEDROCK: "1" }),
          "not json",
          "null",
          JSON.stringify({ permissions: {} }),
          settings({ CLAUDE_CODE_USE_BEDROCK: "0" }),
        ],
        false,
      ),
    ).toBeUndefined();
    expect(
      managedRouting(
        [
          settings({ OTHER: "1" }),
          settings({ ANTHROPIC_BEDROCK_BASE_URL: "https://b" }),
        ],
        false,
      ),
    ).toBe("ANTHROPIC_BEDROCK_BASE_URL");
    expect(managedRouting([], false)).toBeUndefined();
  });

  it("names a no-proxy list that may miss the generation, only where a proxy applies", () => {
    const list = (value: string) => settings({ NO_PROXY: value });
    // No proxy anywhere: a list of its own sends nothing to one.
    expect(managedRouting([list("corp.example")], false)).toBeUndefined();
    // The app's environment has a proxy, or managed settings set one.
    expect(managedRouting([list("corp.example")], true)).toBe("NO_PROXY");
    for (const proxy of ["https_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"])
      expect(
        managedRouting(
          [settings({ [proxy]: "http://p:8080", no_proxy: "" })],
          false,
        ),
      ).toBe("no_proxy");
    for (const reaches of [
      "*",
      "corp.example, 127.0.0.1",
      "127.0.0.1/32",
      "127.0.0.0/8",
    ])
      expect(managedRouting([list(reaches)], true)).toBeUndefined();
    // A port is the generation's only by chance; other ranges, unsure.
    for (const misses of ["127.0.0.1:8080", "127.0.0.0/16", "localhost"])
      expect(managedRouting([list(misses)], true)).toBe("NO_PROXY");
    // Unset, it leaves Buzz's process env list in place.
    expect(managedRouting([settings({ OTHER: "1" })], true)).toBeUndefined();
    // A provider or endpoint is named first.
    expect(
      managedRouting(
        [settings({ NO_PROXY: "x", ANTHROPIC_BASE_URL: "https://e" })],
        true,
      ),
    ).toBe("ANTHROPIC_BASE_URL");
  });
});

describe("noProxy", () => {
  it("joins both inherited lists once each, with loopback added", () => {
    expect(noProxy(["", ""])).toBe("127.0.0.1,localhost");
    expect(noProxy(["corp.example, .internal", "corp.example,localhost"])).toBe(
      "corp.example,.internal,localhost,127.0.0.1",
    );
  });
});

describe("ClaudeForwarding.open", () => {
  it("refuses before pushing anything when managed settings route Claude elsewhere", async () => {
    const h = harness([], { delays: [1] }, async () => [
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
    ]);
    await expect(
      h.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(managedRefusal("CLAUDE_CODE_USE_BEDROCK"));
    expect(h.calls).toEqual([]);
    expect(h.listeners.size).toBe(0);
  });

  it("refuses when managed settings can't be read, and opens past ones that don't route", async () => {
    const unreadable = harness([], { delays: [1] }, async () => {
      throw new Error("exit 1");
    });
    await expect(
      unreadable.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(MANAGED_UNREADABLE);
    expect(unreadable.calls).toEqual([]);

    const plain = harness([], { delays: [] }, async () => [
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } }),
    ]);
    const generation = await plain.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    expect(generation.url).toBe("http://127.0.0.1:9/h1");
  });

  it("gives the generation the inherited no-proxy lists with loopback, and refuses without them", async () => {
    const proxied = harness(
      [],
      { delays: [] },
      async () => [],
      async () => ({ lists: ["corp.example", ".internal"], proxied: true }),
    );
    const generation = await proxied.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    expect(generation.noProxy).toBe(
      "corp.example,.internal,127.0.0.1,localhost",
    );

    const unreadable = harness(
      [],
      { delays: [1] },
      async () => [],
      async () => {
        throw new Error("exit 1");
      },
    );
    await expect(
      unreadable.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(NO_PROXY_UNREADABLE);
    expect(unreadable.calls).toEqual([]);
  });

  it("refuses a managed no-proxy list that misses the generation only under a proxy", async () => {
    const managed = async () => [
      JSON.stringify({ env: { NO_PROXY: "corp.example" } }),
    ];
    const proxied = harness([], { delays: [] }, managed, async () => ({
      lists: ["", ""],
      proxied: true,
    }));
    await expect(
      proxied.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(managedRefusal("NO_PROXY"));
    expect(proxied.calls).toEqual([]);
    const direct = harness([], { delays: [] }, managed);
    await expect(
      direct.forwarding.open(AGENT, eligible(2), turn, signal),
    ).resolves.toMatchObject({ url: "http://127.0.0.1:9/h1" });
  });

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

  it("drops the revision's access on a gateway 401 or 403, revoking the generation", async () => {
    for (const status of [401, 403]) {
      const h = harness();
      const generation = await h.forwarding.open(
        AGENT,
        eligible(2),
        turn,
        signal,
      );
      const emit = nth(h.events);
      emit({ type: "admitted", request: 1, class: "inference", child: false });
      expect(generation.admitted()).toBe(true);
      // Others are Claude's to retry, or its own failures.
      for (const other of [429, 500, 502, 404, null])
        emit({ type: "finished", request: 1, status: other, aborted: false });
      expect(h.routes.invalidateRoute).not.toHaveBeenCalled();
      expect(generation.isRevoked()).toBe(false);
      emit({ type: "finished", request: 2, status, aborted: false });
      expect(h.routes.invalidateRoute).toHaveBeenCalledWith(AGENT, 2);
      expect(generation.isRevoked()).toBe(true);
      expect(h.calls.at(-1)).toBe("push route-1 3 true");
    }
  });

  it("tries an open native can't reach again, at the same revision, until its bound", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([], { delays: [10, 20] });
      vi.mocked(h.native.open).mockRejectedValue(new Error(UNREACHABLE));
      const result = h.forwarding.open(AGENT, eligible(2), turn, signal);
      const failed = expect(result).rejects.toThrow(UNAVAILABLE);
      await vi.advanceTimersByTimeAsync(9);
      expect(h.native.open).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.native.open).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      await failed;
      expect(h.native.open).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(h.native.open)
          .mock.calls.map(([, options]) => options.routeRevision),
      ).toEqual([2, 2, 2]);
      expect(h.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens once native can be reached again within the bound", async () => {
    const h = harness([], { delays: [1, 1] });
    vi.mocked(h.native.push).mockRejectedValueOnce(new Error(UNREACHABLE));
    vi.mocked(h.native.open).mockRejectedValueOnce(new Error(UNREACHABLE));
    const generation = await h.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    expect(generation.url).toBe("http://127.0.0.1:9/h1");
    expect(h.native.push).toHaveBeenCalledTimes(3);
    expect(h.native.open).toHaveBeenCalledTimes(2);
  });

  it("never retries a refusal, a route change or a stopped turn", async () => {
    const refused = harness([{ type: "refused", current: 3, admits: true }], {
      delays: [1, 1],
    });
    await expect(
      refused.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(refused.native.open).toHaveBeenCalledTimes(1);

    const moved = harness([], { delays: [1, 1] });
    vi.mocked(moved.native.open).mockImplementationOnce(async () => {
      moved.setRoute(eligible(3));
      throw new Error(UNREACHABLE);
    });
    await expect(
      moved.forwarding.open(AGENT, eligible(2), turn, signal),
    ).rejects.toThrow(CHANGED);
    expect(moved.native.open).toHaveBeenCalledTimes(1);

    const stopped = harness([], { delays: [1_000] });
    const controller = new AbortController();
    vi.mocked(stopped.native.open).mockImplementationOnce(async () => {
      queueMicrotask(() => controller.abort(new Error("Stopped")));
      throw new Error(UNREACHABLE);
    });
    await expect(
      stopped.forwarding.open(AGENT, eligible(2), turn, controller.signal),
    ).rejects.toThrow("Stopped");
    expect(stopped.native.open).toHaveBeenCalledTimes(1);
  });

  it("never retries what native decides before making a generation, which leaves none open", async () => {
    // `host_forward.rs` answers these before inserting a generation: each
    // fails the same way again, and there is nothing of it to close.
    for (const message of [
      "The page reloaded",
      "Gateway forwarding is off",
      "The agent gateway is not declared",
      "Too many forwarding routes",
      "Too many forwarding generations are open",
    ])
      for (const method of ["push", "open"] as const) {
        const h = harness([], { delays: [1, 1] });
        vi.mocked(h.native[method]).mockRejectedValue(new Error(message));
        await expect(
          h.forwarding.open(AGENT, eligible(2), turn, signal),
        ).rejects.toThrow(UNAVAILABLE);
        expect(h.native[method]).toHaveBeenCalledTimes(1);
        expect(h.native.close).not.toHaveBeenCalled();
        expect(h.listeners.size).toBe(0);
      }
  });

  it("keeps an agent's native route key across instances", async () => {
    const other = "d".repeat(64);
    const newer = "9".repeat(64);
    const keyOf = (call: string | undefined) => call?.split(" ")[1];
    const first = harness();
    await first.forwarding.open(other, eligible(2), turn, signal);
    // A new instance, as after the plugin is disabled and enabled again:
    // the agent keeps its key, and a new agent never takes it.
    const second = harness();
    await second.forwarding.open(newer, eligible(2), turn, signal);
    await second.forwarding.open(other, eligible(2), turn, signal);
    expect(keyOf(second.calls[2])).toBe(keyOf(first.calls[0]));
    expect(keyOf(second.calls[0])).not.toBe(keyOf(first.calls[0]));
  });

  it("counts only model requests as admitted", async () => {
    const h = harness();
    const generation = await h.forwarding.open(
      AGENT,
      eligible(2),
      turn,
      signal,
    );
    const emit = nth(h.events);
    emit({ type: "admitted", request: 1, class: "discovery", child: false });
    expect(generation.admitted()).toBe(false);
    emit({ type: "admitted", request: 2, class: "inference", child: false });
    expect(generation.admitted()).toBe(true);
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
    const h = harness([], undefined, undefined, undefined, GOOSE);
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
    const h = harness([], undefined, undefined, undefined, GOOSE);
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
  {
    revision = 2,
    admitted = true,
  }: { revision?: number; admitted?: boolean } = {},
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
    revision,
    noProxy: "127.0.0.1,localhost",
    isSealed: () => sealed,
    admitted: () => admitted,
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
  wrap: (process: HostProcess, fake: FakeClaude) => HostProcess = (process) =>
    process,
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
    spawn: async (id, options) => {
      const process = fake.spawn(id, options);
      const started = fake.processes.at(-1);
      if (started) {
        started.hold = true;
        spawned(started);
      }
      return started ? wrap(await process, started) : process;
    },
    store,
    launch: async () => ({ cwd: "/work", systemPrompt: "prompt" }),
    fingerprint,
    newId: () => `new-${++ids}`,
  });
  const log: string[] = [];
  const opened: [string, unknown][] = [];
  // Dispatched at revision 2, as each generation opens.
  const forward: Forward = Object.assign(
    async (session: string, saved: unknown) => {
      opened.push([session, saved]);
      log.push(`open g${opened.length}`);
      // As `bindSession` does: a saved binding is kept, else one is minted.
      return {
        generation: generation(`g${opened.length}`, log),
        binding: (saved as GatewayBinding | undefined) ?? binding,
      };
    },
    { revision: 2 },
  );
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
      JSON.stringify({ env: forwardEnv("http://127.0.0.1:9/g1") }),
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

  it("steers a message sent mid-turn at the same revision into the busy process, on its generation and model", async () => {
    const { sessions, log, opened, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, {
      forward,
      pick: { model: "claude-opus-4-6", effort: "high" },
    });
    await flush();
    const second = sessions.deliver("c", "two", 2, {
      forward,
      steer: "steer: two",
      pick: { model: "claude-haiku-4-5", effort: "low" },
    });
    await flush();
    const process = nth(claudes());
    expect(process.prompts).toEqual(["one", "steer: two"]);
    // The running turn's model and effort, and no switch mid-turn.
    expect(process.models).toEqual(["claude-opus-4-6", "claude-opus-4-6"]);
    expect(process.efforts).toEqual(["high", "high"]);
    expect(
      process.received.filter(
        (message) =>
          message.type === "control_request" &&
          (message.request as { model?: string }).model === "claude-haiku-4-5",
      ),
    ).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(claudes()).toHaveLength(1);
    process.finish();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    await flush();
    expect(log).toEqual(["open g1", "seal g1", "close g1", "closed g1"]);
  });

  it("runs a steer again in a turn of its own when the running turn ended before Claude took it", async () => {
    // Claude reports the running turn's end before it reads the steer.
    const { sessions, log, opened, forward, claudes } = pool(
      undefined,
      undefined,
      undefined,
      (process, fake) => ({
        ...process,
        write: async (data: string) => {
          if (data.includes("steer: two")) fake.finish();
          return process.write(data);
        },
      }),
    );
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    const second = sessions.deliver("c", "two", 2, {
      forward,
      steer: "steer: two",
    });
    expect(await first).toEqual({ ok: true });
    await flush();
    expect(nth(claudes()).prompts).toEqual(["one"]);
    expect(nth(claudes()).killed).toBe(true);
    expect(opened).toHaveLength(2);
    const next = nth(claudes(), 1);
    expect(next.prompts).toEqual(["two"]);
    expect(settingsOf(next)).toContain("/g2");
    next.finish();
    expect(await second).toEqual({ ok: true });
    await flush();
    expect(log).toEqual([
      "open g1",
      "seal g1",
      "close g1",
      "closed g1",
      "open g2",
      "seal g2",
      "close g2",
      "closed g2",
    ]);
  });

  it("never steers a message into a running forwarded compaction", async () => {
    const { sessions, all, opened, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    nth(claudes()).finish();
    await first;
    await flush();
    expect(all.has("c")).toBe(true);
    const compacting = sessions.compact("c", forward);
    await flush();
    const compactor = nth(claudes(), 1);
    expect(compactor.prompts).toEqual(["/compact"]);
    const message = sessions.deliver("c", "two", 2, {
      forward,
      steer: "steer: two",
    });
    await flush();
    expect(compactor.prompts).toEqual(["/compact"]);
    compactor.finish();
    expect(await compacting).toEqual({ ok: true });
    await flush();
    const next = nth(claudes(), 2);
    expect(next.prompts).toEqual(["two"]);
    next.finish();
    expect(await message).toEqual({ ok: true });
    expect(opened).toHaveLength(3);
  });

  it("stops a message queued two deep at once, keeping the order of those behind it", async () => {
    const { sessions, forward, claudes } = pool();
    const later = Object.assign(
      (session: string, saved: unknown) => forward(session, saved),
      { revision: 3 },
    );
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    // Waits behind the running turn's barrier, holding the handover.
    const second = sessions.deliver("c", "two", 2, { forward: later });
    const stop = new AbortController();
    const third = sessions.deliver("c", "three", 3, {
      forward: later,
      signal: stop.signal,
    });
    const fourth = sessions.deliver("c", "four", 4, { forward: later });
    await flush();
    stop.abort();
    expect(await third).toEqual({ ok: true, undelivered: true });
    nth(claudes()).finish();
    expect(await first).toEqual({ ok: true });
    await flush();
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
    await flush();
    nth(claudes(), 2).finish();
    expect(await fourth).toEqual({ ok: true });
    expect(claudes().map((process) => process.prompts)).toEqual([
      ["one"],
      ["two"],
      ["four"],
    ]);
  });

  it("settles a forwarded turn stopped before any request as stopped, not bypassed", async () => {
    const { sessions, log, claudes } = pool();
    const delivered = sessions.deliver("c", "hi", 1, {
      forward: async () => ({
        generation: generation("g", log, undefined, { admitted: false }),
        binding,
      }),
    });
    await flush();
    await sessions.interrupt("c");
    // Claude ends a turn stopped mid-tool as aborted tools.
    const process = nth(claudes());
    process.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      result: "Tool use was interrupted",
      session_id: "new-1",
    });
    sessionState(process, "idle");
    expect(await delivered).toEqual({ ok: true, stopped: true });
  });

  it("queues a message whose routing doesn't match the busy forwarded turn", async () => {
    const { sessions, log, opened, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    // Dispatched at a newer revision than the running generation's.
    const second = sessions.deliver("c", "two", 2, {
      forward: Object.assign(
        (session: string, saved: unknown) => forward(session, saved),
        { revision: 3 },
      ),
      steer: "steer: two",
    });
    // And one that falls back, on Claude's own configuration.
    const third = sessions.deliver("c", "three", 3, { steer: "steer: three" });
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
    await flush();
    const last = nth(claudes(), 2);
    expect(last.prompts).toEqual(["three"]);
    expect(settingsOf(last)).toBeUndefined();
    last.finish();
    expect(await third).toEqual({ ok: true });
  });

  it("never steers into a sealed or revoked generation", async () => {
    for (const end of ["seal", "revoke"] as const) {
      const { sessions, log, forward, claudes } = pool();
      let made: ReturnType<typeof generation> | undefined;
      const first = sessions.deliver("c", "one", 1, {
        forward: Object.assign(
          async () => {
            made = generation("g", log);
            return { generation: made, binding };
          },
          { revision: 2 },
        ),
      });
      await flush();
      if (end === "seal") made?.seal();
      else made?.revoke();
      const second = sessions.deliver("c", "two", 2, {
        forward,
        steer: "steer: two",
      });
      await flush();
      expect(nth(claudes()).prompts).toEqual(["one"]);
      nth(claudes()).finish();
      await first;
      await flush();
      nth(claudes(), 1).finish();
      expect(await second).toEqual({ ok: true });
      expect(nth(claudes(), 1).prompts).toEqual(["two"]);
    }
  });

  it("stops a message queued behind a forwarded turn alone, leaving that turn running", async () => {
    const { sessions, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, { forward });
    await flush();
    const stop = new AbortController();
    const second = sessions.deliver("c", "two", 2, {
      forward: Object.assign(
        (session: string, saved: unknown) => forward(session, saved),
        { revision: 3 },
      ),
      signal: stop.signal,
    });
    await flush();
    stop.abort();
    expect(await second).toEqual({ ok: true, undelivered: true });
    const process = nth(claudes());
    expect(process.received.filter(isInterrupt)).toEqual([]);
    expect(process.killed).toBe(false);
    process.finish();
    expect(await first).toEqual({ ok: true });
    expect(claudes()).toHaveLength(1);
  });

  it("releases the conversation when a forwarded turn's refresh fails", async () => {
    const { sessions, log, forward, claudes } = pool();
    const first = sessions.deliver("c", "one", 1, {
      forward,
      refresh: async () => {
        throw new Error("read failed");
      },
    });
    await expect(first).rejects.toThrow("read failed");
    await flush();
    // Its process stopped and its generation closed, so the next turn
    // starts at once, not at the idle timeout.
    expect(log).toEqual(["open g1", "close g1", "closed g1"]);
    expect(nth(claudes()).killed).toBe(true);
    const second = sessions.deliver("c", "two", 2, { forward });
    await flush();
    expect(log.at(-1)).toBe("open g2");
    nth(claudes(), 1).finish();
    expect(await second).toEqual({ ok: true });
  });

  it("fails a forwarded turn that made no model request as bypassed, and says so before Claude's own failure", async () => {
    // Native admitted nothing: Claude's requests went elsewhere, or it made
    // none. Both fail, since a turn that ran can't tell them apart. One
    // Claude itself failed, as through a proxy that refuses it, says no
    // request reached the gateway, then Claude's own error, which may have
    // nothing to do with routing.
    for (const [result, settled] of [
      [{}, { ok: false, error: BYPASSED }],
      [
        { error: "Overloaded" },
        { ok: false, error: `${UNREACHED} Overloaded` },
      ],
      [
        {
          error:
            "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
        },
        {
          ok: false,
          error: `${UNREACHED} API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`,
        },
      ],
    ] as const) {
      const { sessions, log, claudes } = pool();
      const delivered = sessions.deliver("c", "hi", 1, {
        forward: async () => ({
          generation: generation("g", log, undefined, { admitted: false }),
          binding,
        }),
      });
      await flush();
      nth(claudes()).finish(result);
      expect(await delivered).toEqual(settled);
    }
    // One the gateway admitted a request for keeps Claude's own error.
    const { sessions, log, claudes } = pool();
    const delivered = sessions.deliver("c", "hi", 1, {
      forward: async () => ({
        generation: generation("g", log, undefined, { admitted: true }),
        binding,
      }),
    });
    await flush();
    nth(claudes()).finish({ error: "Overloaded" });
    expect(await delivered).toEqual({ ok: false, error: "Overloaded" });
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
