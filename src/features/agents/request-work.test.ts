import { afterEach, expect, it, vi } from "vitest";
import {
  ACTIVITY_RECORD_LIMIT,
  ACTIVITY_TURN_LIMIT,
  createAgentActivity,
} from "./activity";
import { requestWork } from "./request-work";

const agent = "a".repeat(64);
const request = "b".repeat(64);
const channel = "htian-playground";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  let generation: number | null = null;
  const activity = createAgentActivity(
    true,
    (current) => {
      generation = current;
    },
    () => true,
  );
  cleanups.push(() => activity.dispose());
  activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  let seq = 0;
  function send(
    kind: string,
    turnId: string,
    trigger?: string,
    channelId = channel,
    author = agent,
    overrides: { seq?: unknown; timestamp?: unknown; payload?: unknown } = {},
  ) {
    if (generation === null) throw new Error("Activity is not active");
    seq++;
    activity.receive(
      {
        id: seq.toString(16).padStart(64, "0"),
        agent: author,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          turnId,
          channelId,
          seq,
          timestamp: new Date().toISOString(),
          payload: { triggeringEventIds: trigger ? [trigger] : [] },
          ...overrides,
        }),
      },
      generation,
    );
  }
  const fill = (count = ACTIVITY_RECORD_LIMIT) => {
    for (let i = 0; i < count; i++) send("acp_read", "unrelated");
  };
  return {
    send,
    fill,
    snapshot: activity.queries.snapshot,
    work: () => requestWork(activity.queries.snapshot(), channel, request),
  };
}

it.each(["turn_completed", "turn_error", "agent_panic"])(
  "preserves %s when unrelated activity overflows the live buffer",
  (terminal) => {
    const f = fixture();
    f.send("turn_started", "other-channel", request, "other-channel");
    f.send("turn_started", "other-agent", request, channel, "c".repeat(64));
    f.fill(ACTIVITY_RECORD_LIMIT - 4);
    f.send("turn_started", "request", request);
    f.send(terminal, "request");
    const expected = terminal === "turn_completed" ? "ended" : "error";
    expect(f.work().find((work) => work.agent === agent)?.state).toBe(expected);
    f.send("acp_read", "unrelated");
    f.send("acp_read", "unrelated");
    expect(f.snapshot().trimmed).toBeGreaterThan(0);
    expect(f.snapshot().records).toHaveLength(ACTIVITY_RECORD_LIMIT);
    expect(f.work().find((work) => work.agent === agent)?.state).toBe(expected);
  },
);

it("keeps a linked turn relevant after its start is trimmed, without backfilling missing starts", async () => {
  const f = fixture();
  f.send("turn_started", "first", request);
  f.fill();
  f.send("turn_started", "second", request);
  f.send("turn_completed", "second");
  expect(f.work()[0]?.state).toBe("working");
  await vi.advanceTimersByTimeAsync(31_000);
  expect(f.work()[0]?.state).toBe("unknown");
  f.send("turn_completed", "first");
  expect(f.work()[0]?.state).toBe("unknown");
  f.fill();
  expect(f.work()).toEqual([]);
});

it("keeps a request uncertain when a linked turn leaves both evidence buffers", () => {
  const f = fixture();
  f.send("turn_started", "first", request);
  for (let i = 0; i < ACTIVITY_TURN_LIMIT; i++) {
    vi.setSystemTime(Date.now() + 1);
    f.send("turn_liveness", `unrelated-${i}`);
  }
  expect(f.snapshot().turns.some((turn) => turn.turnId === "first")).toBe(
    false,
  );
  f.send("turn_started", "second", request);
  f.send("turn_completed", "second");
  expect(f.work()[0]?.state).toBe("unknown");
});

it("keeps uncertainty when duplicate starts overflow the bounded trigger associations", () => {
  const f = fixture();
  const ids = Array.from({ length: 64 }, (_, i) =>
    (i + 1).toString(16).padStart(64, "0"),
  );
  f.send("turn_started", "first", undefined, channel, agent, {
    payload: { triggeringEventIds: ids },
  });
  f.send("turn_started", "first", request);
  f.fill();
  f.send("turn_started", "second", request);
  f.send("turn_completed", "second");
  expect(f.work()[0]?.state).toBe("unknown");
});

it.each([
  { name: "mixed invalid IDs", ids: [request, "invalid"] },
  {
    name: "more than 64 IDs",
    ids: [
      request,
      ...Array.from({ length: 64 }, (_, i) =>
        (i + 1).toString(16).padStart(64, "0"),
      ),
    ],
  },
])("does not associate a start containing $name", ({ ids }) => {
  const f = fixture();
  f.send("turn_started", "malformed", undefined, channel, agent, {
    payload: { triggeringEventIds: ids },
  });
  f.send("turn_completed", "malformed");
  expect(f.work()).toEqual([]);
  f.fill();
  f.send("turn_started", "valid", request);
  f.send("turn_completed", "valid");
  expect(f.work()[0]?.state).toBe("ended");
});

it.each([
  { name: "a duplicate start", kind: "turn_started", overrides: {} },
  {
    name: "an invalid sequence",
    kind: "unrecognized",
    overrides: { seq: "invalid" },
  },
  {
    name: "an invalid timestamp start",
    kind: "turn_started",
    overrides: { timestamp: "invalid" },
  },
  {
    name: "a future timestamp start",
    kind: "turn_started",
    overrides: { timestamp: new Date(1_800_000_060_000).toISOString() },
  },
])(
  "keeps ambiguity after trimming $name from the same turn",
  ({ kind, overrides }) => {
    const f = fixture();
    f.send(kind, "first", request, channel, agent, overrides);
    f.fill(ACTIVITY_RECORD_LIMIT - 4);
    f.send("turn_started", "first", request);
    f.send("turn_completed", "first");
    f.send("turn_started", "second", request);
    expect(f.snapshot().trimmed).toBe(0);
    f.send("turn_completed", "second");
    expect(f.snapshot().trimmed).toBe(1);
    expect(f.work()[0]?.state).toBe("unknown");
  },
);

it.each(["invalid", new Date(1_800_000_060_000).toISOString()])(
  "keeps a rejected start relevant after its raw record is trimmed (%s)",
  (timestamp) => {
    const f = fixture();
    f.send("turn_started", "rejected", request, channel, agent, { timestamp });
    f.fill(ACTIVITY_RECORD_LIMIT - 2);
    f.send("turn_started", "second", request);
    f.send("turn_completed", "second");
    expect(f.snapshot().trimmed).toBe(1);
    expect(f.work()[0]?.state).toBe("unknown");
  },
);

it("retains an earlier request association when duplicate starts name different triggers", () => {
  const f = fixture();
  f.send("turn_started", "first", request);
  f.fill(ACTIVITY_RECORD_LIMIT - 4);
  f.send("turn_started", "first", "d".repeat(64));
  f.send("turn_completed", "first");
  f.send("turn_started", "second", request);
  f.send("turn_completed", "second");
  expect(f.snapshot().trimmed).toBe(1);
  expect(f.work()[0]?.state).toBe("unknown");
});

it("keeps ambiguity when the trimmed record is an unknown batch child with an invalid sequence", () => {
  const f = fixture();
  f.send("batch", "envelope", undefined, channel, agent, {
    payload: {
      events: [
        {
          kind: "unrecognized",
          turnId: "first",
          channelId: channel,
          seq: "invalid",
          timestamp: new Date().toISOString(),
        },
      ],
    },
  });
  f.fill(ACTIVITY_RECORD_LIMIT - 4);
  f.send("turn_started", "first", request);
  f.send("turn_completed", "first");
  f.send("turn_started", "second", request);
  f.send("turn_completed", "second");
  expect(f.snapshot().trimmed).toBe(1);
  expect(f.work()[0]?.state).toBe("unknown");
});

it.each([
  { kind: "unrecognized", overrides: { seq: "invalid" } },
  { kind: "turn_started", overrides: { timestamp: "invalid" } },
])(
  "keeps ambiguity evicted before lifecycle creation ($kind)",
  ({ kind, overrides }) => {
    const f = fixture();
    f.send(kind, "first", undefined, channel, agent, overrides);
    f.fill();
    f.send("turn_started", "first", request);
    f.send("turn_completed", "first");
    expect(f.work()[0]?.state).toBe("unknown");
  },
);
