import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "./activity";
import { reportedSessionSettings } from "./session-settings";

const agent = "a".repeat(64),
  relay = "wss://fixture.example";
const options = [
  { id: "model-choice", category: "model", currentValue: "actual-model" },
  { id: "reasoning", category: "thought_level", currentValue: "low" },
];
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const observe = vi.fn();
  const owner = createAgentActivity(
    true,
    observe,
    (channel) => channel !== "denied",
  );
  const release = owner.queries.activate();
  owner.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  let serial = 0;
  const item = (kind: string, seq: number, payload: object, extra = {}) => ({
    kind,
    seq,
    payload,
    timestamp: new Date().toISOString(),
    agentIndex: 0,
    channelId: "channel",
    turnId: "turn",
    sessionId: null,
    ...extra,
  });
  const capture = (extra = {}) =>
    item(
      "session_config_captured",
      5,
      { relayUrl: relay, configOptions: options },
      extra,
    );
  const resolve = (extra = {}) =>
    item(
      "session_resolved",
      6,
      { sessionId: "S", isNewSession: true },
      { sessionId: "S", ...extra },
    );
  const send = (
    value: unknown,
    pubkey = agent,
    generation = observe.mock.lastCall?.[0],
  ) =>
    owner.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify(value),
      },
      generation,
    );
  return {
    owner,
    release,
    item,
    capture,
    resolve,
    send,
    reports: () =>
      reportedSessionSettings(owner.queries.snapshot().records, agent, relay),
  };
}
afterEach(() => vi.useRealTimers());

it("joins startup captures to their real session even when frames arrive out of order", () => {
  const f = fixture();
  f.send(f.resolve());
  expect(f.reports()).toEqual([]);
  f.send(f.capture());
  expect(f.reports()).toEqual([
    {
      sessionId: "S",
      timestamp: Date.now(),
      model: "actual-model",
      effort: "low",
      requestedModel: null,
      modelFailure: null,
      requestedEffort: null,
      effortRejected: false,
    },
  ]);
  f.release();
});

it.each([
  { turnId: "other" },
  { agentIndex: 1 },
  { channelId: "other" },
  { payload: { sessionId: "S", isNewSession: false } },
  { seq: 4 },
  { sessionId: "different" },
])("does not correlate a different session boundary: %j", (extra) => {
  const f = fixture();
  f.send(f.capture());
  f.send(f.resolve(extra));
  expect(f.reports()).toEqual([]);
  f.release();
});

it("reports model and effort rejection from correlated runtime evidence without raw errors", () => {
  const f = fixture();
  const events = [
    f.item("control_result", 1, {
      type: "switch_model",
      status: "failure",
      modelId: "requested-model",
      error: "secret-error",
    }),
    f.item("acp_write", 2, {
      id: 20,
      method: "session/set_config_option",
      params: { sessionId: "S", configId: "reasoning", value: "high" },
    }),
    f.item("acp_read", 3, {
      id: 20,
      error: { code: -32602, message: "secret-error" },
    }),
    f.capture(),
    f.resolve(),
  ];
  f.send({ kind: "batch", payload: { events } });
  expect(f.reports()[0]).toMatchObject({
    model: "actual-model",
    modelFailure: "failure",
    requestedModel: "requested-model",
    effort: "low",
    requestedEffort: "high",
    effortRejected: true,
  });
  expect(JSON.stringify(f.reports())).not.toContain("secret-error");
  f.release();
});

it("does not mistake adapter requests, unmatched IDs or late responses for effort rejection", () => {
  const f = fixture();
  f.send(
    f.item("acp_write", 2, {
      id: 20,
      method: "session/set_config_option",
      params: { sessionId: "S", configId: "reasoning", value: "high" },
    }),
  );
  f.send(
    f.item("acp_read", 3, { id: 20, method: "request_permission", error: {} }),
  );
  f.send(f.item("acp_read", 4, { id: 21, error: {} }));
  f.send(f.item("acp_read", 7, { id: 20, error: {} }));
  f.send(f.capture());
  f.send(f.resolve());
  expect(f.reports()[0]).toMatchObject({
    requestedEffort: "high",
    effortRejected: false,
  });
  f.release();
});

it("keeps legacy applied identity, missing effort and absent settings truthful", () => {
  const f = fixture();
  f.send(
    f.capture({
      payload: {
        relayUrl: relay,
        models: {
          currentModelId: "legacy",
          availableModels: [{ id: "not-applied" }],
        },
      },
    }),
  );
  f.send(f.resolve());
  expect(f.reports()[0]).toMatchObject({ model: "legacy", effort: null });
  f.send(
    f.capture({
      seq: 8,
      payload: {
        relayUrl: relay,
        configOptions: [{ category: "model", currentValue: "x".repeat(257) }],
      },
    }),
  );
  f.send(f.resolve({ seq: 9 }));
  expect(f.reports()[0]).toMatchObject({ model: null, effort: null });
  f.release();
});

it("respects owner, channel and relay boundaries and clears evidence across generations", () => {
  const f = fixture();
  f.send(f.capture(), "b".repeat(64));
  f.send(f.resolve());
  expect(f.reports()).toEqual([]);
  f.send({
    kind: "batch",
    payload: {
      events: [f.capture(), f.item("acp_read", 1, {}, { channelId: "denied" })],
    },
  });
  expect(f.reports()).toEqual([]);
  f.send(
    f.capture({ payload: { relayUrl: "wss://other", configOptions: options } }),
  );
  expect(f.reports()).toEqual([]);
  f.send(f.capture());
  expect(f.reports()).toHaveLength(1);
  f.owner.clear();
  f.send(f.capture(), agent, 1);
  f.send(f.resolve(), agent, 1);
  expect(f.reports()).toEqual([]);
  f.release();
});

it("bounds reported sessions and handles repeated per-process sequences independently", () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) {
    vi.setSystemTime(Date.now() + 1000);
    const extra = { turnId: `turn-${i}`, sessionId: `S${i}` };
    f.send(f.capture(extra));
    f.send(
      f.resolve({
        ...extra,
        payload: { sessionId: `S${i}`, isNewSession: true },
      }),
    );
  }
  expect(f.reports().map((r) => r.sessionId)).toEqual([
    "S7",
    "S6",
    "S5",
    "S4",
    "S3",
  ]);
  f.release();
});
