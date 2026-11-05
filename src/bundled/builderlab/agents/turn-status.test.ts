import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../../features/agents/activity";
import { requestWork } from "../../../features/agents/request-work";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import type { HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";
import { startTurnStatusRecovery } from "./turn-status";

const agent = "ab".repeat(32),
  request = "cd".repeat(32);
const connected = {
  status: "connected",
  routes: [{ id: "observer", status: "live", replay: "unknown" }],
} as const;
const response = (outcomes: object): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ outcomes }),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function fixture(
  start: "turn_started" | "turn_liveness" | "resolve" = "turn_started",
) {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const result = deferred<HostResponse>();
  const started = deferred<void>();
  const hostRequest = vi.fn(async (input: { url: string; body?: string }) => {
    if (input.url.endsWith("/list-agents"))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 1,
          agents: [
            {
              agent_id: "agent",
              agent_name: "Helper",
              agent_pubkey: agent,
              status: 2,
            },
          ],
        }),
      };
    started.resolve();
    return result.promise;
  });
  let subject = "owner";
  const session = createOAuthSession(
    async () => ({
      value: subject,
      account: {
        subject,
        email: "fixture@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: hostRequest },
  );
  await session.signIn();
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state(connected);
  let relaySession = {
    agentActivity: activity.queries,
  } as unknown as RelaySession;
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      origin: "https://primary.example",
      session: relaySession,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const stop = startTurnStatusRecovery({
    relay,
    session,
    client: createAgentClient(session, null),
  });
  const send = (
    kind: string,
    seq: number,
    payload: unknown = {},
    turnId = "task",
    pubkey = agent,
  ) =>
    activity.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Date.now() / 1000,
        plaintext: JSON.stringify({
          kind,
          seq,
          turnId,
          sessionId: start === "resolve" ? null : "session",
          channelId: "channel",
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      generation,
    );
  send(start === "turn_liveness" ? "turn_liveness" : "turn_started", 1, {
    triggeringEventIds: [request],
  });
  if (start === "resolve")
    send("session_resolved", 2, { sessionId: "session" });
  return {
    activity,
    session,
    send,
    result,
    started,
    hostRequest,
    async changeAccount() {
      session.signOut();
      subject = "other-owner";
      hostRequest.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ status: 1, agents: [] }),
      });
      await session.signIn();
    },
    changeCommunity() {
      relaySession = {
        agentActivity: createAgentActivity(
          true,
          () => {},
          () => true,
        ).queries,
      } as unknown as RelaySession;
      for (const listener of listeners) listener();
    },
    work: () =>
      requestWork(activity.queries.snapshot(), "channel", request)[0]?.state,
    dispose() {
      stop();
      release();
      activity.dispose();
      session.dispose();
    },
  };
}

it.each([
  ["completed", "ended"],
  ["failed", "error"],
  ["cancelled", "stopped"],
])(
  "recovers missed %s terminal status through the real lifecycle",
  async (outcome, expected) => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(31000);
      await f.started.promise;
      expect(f.work()).toBe("unknown");
      f.result.resolve(response({ task: outcome }));
      await vi.waitFor(() => expect(f.work()).toBe(expected));
      expect(f.activity.queries.snapshot().records).toHaveLength(1);
      // Neither a late heartbeat nor a different request can inherit the result.
      f.send("turn_liveness", 2);
      expect(f.work()).toBe(expected);
      expect(
        requestWork(f.activity.queries.snapshot(), "channel", "ef".repeat(32)),
      ).toEqual([]);
    } finally {
      f.result.resolve(response({}));
      f.dispose();
    }
  },
);

it.each(["turn_liveness", "resolve"] as const)(
  "recovers a %s turn without inventing message attribution",
  async (start) => {
    const f = await fixture(start);
    try {
      f.result.resolve(response({ task: "failed" }));
      await vi.advanceTimersByTimeAsync(31000);
      await vi.waitFor(() =>
        expect(f.activity.queries.snapshot().turns[0]?.outcome).toBe("error"),
      );
      expect(f.work()).toBe(start === "turn_liveness" ? undefined : "error");
    } finally {
      f.dispose();
    }
  },
);

it("refreshes the owned agent inventory when another agent appears", async () => {
  const f = await fixture();
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    const newcomer = "ef".repeat(32);
    f.hostRequest.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agents: [
          {
            agent_id: "new",
            agent_name: "New helper",
            agent_pubkey: newcomer,
            status: 2,
          },
        ],
      }),
    });
    f.hostRequest.mockResolvedValueOnce(response({ newTask: "failed" }));
    f.send(
      "turn_started",
      1,
      { triggeringEventIds: [request] },
      "newTask",
      newcomer,
    );
    await vi.advanceTimersByTimeAsync(31000);
    await vi.waitFor(() =>
      expect(
        f.activity.queries
          .snapshot()
          .turns.find((turn) => turn.turnId === "newTask")?.outcome,
      ).toBe("error"),
    );
  } finally {
    f.dispose();
  }
});

it("batches at most 64 exact tasks per read and does not reread them on every activity tick", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 65; i++)
      f.send("turn_started", 1, { triggeringEventIds: [request] }, `task-${i}`);
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await vi.waitFor(() =>
      expect(
        f.hostRequest.mock.calls.filter(([input]) =>
          input.url.endsWith("/get-agent-turn-status"),
        ),
      ).toHaveLength(2),
    );
    const batches = f.hostRequest.mock.calls
      .filter(([input]) => input.url.endsWith("/get-agent-turn-status"))
      .map(([input]) => JSON.parse(input.body ?? "{}").task_ids);
    expect(batches.map((ids) => ids.length)).toEqual([64, 2]);
    expect(new Set(batches.flat()).size).toBe(66);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      f.hostRequest.mock.calls.filter(([input]) =>
        input.url.endsWith("/get-agent-turn-status"),
      ),
    ).toHaveLength(2);
  } finally {
    f.dispose();
  }
});
it("leaves missing status unknown and reads it again after reconnect", async () => {
  const f = await fixture();
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    expect(f.work()).toBe("unknown");
    f.hostRequest.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agents: [
          {
            agent_id: "agent",
            agent_name: "Helper",
            agent_pubkey: agent,
            status: 2,
          },
        ],
      }),
    });
    f.hostRequest.mockResolvedValueOnce(response({ task: "failed" }));
    f.activity.state({ status: "retrying", routes: [] });
    f.activity.state(connected);
    await vi.waitFor(() => expect(f.work()).toBe("error"));
  } finally {
    f.dispose();
  }
});

it("does not overwrite a live terminal with a delayed readback", async () => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    f.send("turn_completed", 2, { outcome: "completed" });
    f.result.resolve(response({ task: "failed" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.work()).toBe("ended");
  } finally {
    f.result.resolve(response({}));
    f.dispose();
  }
});

it.each(["sign-out", "account-change", "community-change", "clear", "dispose"])(
  "ignores a delayed readback after %s",
  async (change) => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(31000);
      await f.started.promise;
      if (change === "sign-out") f.session.signOut();
      else if (change === "account-change") await f.changeAccount();
      else if (change === "community-change") f.changeCommunity();
      else if (change === "clear") f.activity.clear();
      else f.activity.dispose();
      f.result.resolve(response({ task: "failed" }));
      await vi.advanceTimersByTimeAsync(1);
      expect(f.work()).toBe(
        ["sign-out", "account-change", "community-change"].includes(change)
          ? "unknown"
          : undefined,
      );
    } finally {
      f.result.resolve(response({}));
      f.dispose();
    }
  },
);
