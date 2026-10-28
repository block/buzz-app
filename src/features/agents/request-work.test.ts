import { afterEach, expect, it, vi } from "vitest";
import { ACTIVITY_RECORD_LIMIT, createAgentActivity } from "./activity";
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
