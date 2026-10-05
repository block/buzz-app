import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentActivity,
  type ActivityTurn,
} from "../../features/agents/activity";
import { matchedSessionTurns, sessionActivity } from "./session-activity";
import {
  DETAIL_BYTE_LIMIT,
  DETAIL_RECORD_LIMIT,
  sessionActivityDetail,
} from "./session-activity-detail";
const id = (n: number) => n.toString(16).padStart(64, "0");
const row = (n: number, parent?: number, channelId = "a") => ({
  id: id(n),
  channelId,
  threadRootId: parent === undefined ? undefined : id(parent),
});
const turn: ActivityTurn = {
  agent: id(90),
  turnId: "turn",
  channelId: "a",
  timestamp: 1,
  state: "working",
  triggeringEventIds: [id(1)],
};
const item = (patch = {}) => ({
  kind: "turn_started",
  turnId: "turn",
  channelId: "a",
  timestamp: new Date().toISOString(),
  payload: { triggeringEventIds: [id(1)] },
  ...patch,
});
const record = (value: unknown, n = 10, agent = id(90)) => ({
  id: id(n),
  agent,
  createdAt: 1,
  receivedAt: 1,
  historical: false,
  kind: "test",
  channelIds: ["a"],
  plaintext: typeof value === "string" ? value : JSON.stringify(value),
});
const snapshot = (
  records: ReturnType<typeof record>[],
  turns: readonly ActivityTurn[] = [turn],
) => ({
  status: "listening" as const,
  records,
  turns,
  typing: [],
  trimmed: 0,
  history: "unavailable" as const,
  hasOlder: false,
  historyOlder: false,
  historySkipped: 0,
  historyAgents: [],
  capture: "unknown" as const,
});
const select = (
  records: ReturnType<typeof record>[],
  turns: readonly ActivityTurn[] = [turn],
) =>
  sessionActivityDetail(
    [row(1), row(2, 1), row(3)],
    snapshot(records, turns),
    "a",
    id(1),
  );
afterEach(() => vi.useRealTimers());
it("uses exact outer agent, explicit child turn/channel and every trigger's one canonical root", () => {
  expect(select([record(item())]).records).toHaveLength(1);
  for (const patch of [
    { channelId: "b" },
    { channelId: null },
    { channelId: undefined },
    { turnId: "other" },
    { turnId: null },
    { turnId: undefined },
  ])
    expect(select([record(item(patch))]).records).toHaveLength(0);
  expect(select([record(item(), 11, id(91))]).records).toHaveLength(0);
  for (const triggeringEventIds of [
    [id(1), id(3)],
    [id(1), id(99)],
    [],
    undefined,
  ])
    expect(
      select([record(item())], [{ ...turn, triggeringEventIds }]).records,
    ).toHaveLength(0);
  expect(select([record(item())], []).records).toHaveLength(0);
  expect(select([], [turn]).records).toHaveLength(0);
});
it("excludes archived records sharing a live agent/turn/channel tuple", () => {
  const historical = { ...record(item(), 10), historical: true };
  const historicalBatch = {
    ...record({ kind: "batch", payload: { events: [item()] } }, 11),
    historical: true,
  };
  const live = record(item(), 12);
  const records = [historical, live, historicalBatch];
  const result = select(records);
  expect(result.records.map((record) => record.envelopeId)).toEqual([live.id]);
  expect(result.trimmed).toBe(0);
  expect(select([historical, historicalBatch]).records).toHaveLength(0);
  expect(records).toEqual([historical, live, historicalBatch]);
});
it("preserves scalar bytes; independently projects only explicitly scoped valid batch children", () => {
  const raw = ` { "kind":"diagnostic", "turnId":"turn", "channelId":"a", "payload":"<img onerror=alert(1)>" } `;
  expect(select([record(raw)]).records[0]).toMatchObject({
    plaintext: raw,
    projected: false,
    envelopeId: id(10),
    id: id(10),
  });
  const good = item({ kind: "acp_read" });
  const batch = {
    kind: "batch",
    channelId: "a",
    turnId: "turn",
    payload: {
      events: [
        null,
        4,
        [],
        { kind: "private" },
        item({ channelId: null }),
        item({ channelId: "other" }),
        good,
        item({
          kind: "batch",
          payload: { events: [item({ turnId: "private-other-turn" })] },
        }),
      ],
    },
  };
  expect(select([record(batch)]).records).toMatchObject([
    {
      id: `${id(10)}:6`,
      envelopeId: id(10),
      plaintext: JSON.stringify(good),
      projected: true,
      kind: "acp_read",
    },
  ]);
  expect(
    select([
      record({
        kind: "batch",
        channelId: "a",
        turnId: "turn",
        payload: { events: "bad" },
      }),
    ]).records,
  ).toHaveLength(0);
  expect(select([record("null"), record("broken", 11)]).records).toHaveLength(
    0,
  );
});
it("shares the 64-trigger bound, rejects unaccepted/conflicting rows and retains ended detail, not a working badge", () => {
  const rows = Array.from({ length: 64 }, (_, i) =>
    row(i + 1, i ? 1 : undefined),
  );
  const ids = rows.map((row) => row.id);
  expect(
    matchedSessionTurns(rows, [{ ...turn, triggeringEventIds: ids }]),
  ).toHaveLength(1);
  expect(
    matchedSessionTurns(rows, [
      { ...turn, triggeringEventIds: [...ids, ids[0] as string] },
    ]),
  ).toHaveLength(0);
  for (const delivery of ["sending", "failed", "unknown"] as const)
    expect(matchedSessionTurns([{ ...row(1), delivery }], [turn])).toHaveLength(
      0,
    );
  for (const delivery of [undefined, "accepted", "seen"] as const)
    expect(matchedSessionTurns([{ ...row(1), delivery }], [turn])).toHaveLength(
      1,
    );
  expect(matchedSessionTurns([row(1), row(1, 3)], [turn])).toHaveLength(0);
  const ended = { ...turn, state: "ended" as const };
  expect(select([record(item())], [ended]).records[0]?.turn.state).toBe(
    "ended",
  );
  expect(sessionActivity(rows, [ended]).size).toBe(0);
});
it("bounds projected child count and UTF-8 bytes without changing retained evidence", () => {
  const many = record({
    kind: "batch",
    payload: { events: Array.from({ length: 103 }, () => item()) },
  });
  const original = many.plaintext;
  const result = select([many]);
  expect(result.records).toHaveLength(DETAIL_RECORD_LIMIT);
  expect(result.trimmed).toBe(3);
  expect(many.plaintext).toBe(original);
  const large = Array.from({ length: 12 }, (_, i) =>
    record(item({ payload: "界".repeat(10000) }), i),
  );
  const bounded = select(large);
  const bytes = bounded.records.reduce(
    (total, record) =>
      total + new TextEncoder().encode(record.plaintext).length,
    0,
  );
  expect(bytes).toBeLessThanOrEqual(DETAIL_BYTE_LIMIT);
  expect(bytes).toBeGreaterThan(DETAIL_BYTE_LIMIT - 31000);
  expect(bounded.trimmed).toBeGreaterThan(0);
});
it("actual fold poison cannot be revived by raw starts, including oversized input; reset clears detail", () => {
  vi.useFakeTimers();
  for (const conflict of [
    item({ payload: { triggeringEventIds: [id(2)] } }),
    item({ payload: { triggeringEventIds: Array(65).fill(id(1)) } }),
    item({ channelId: "b" }),
  ]) {
    const service = createAgentActivity(
      true,
      () => {},
      () => true,
    );
    const stop = service.queries.activate();
    const ingest = (value: unknown, n: number) =>
      service.receive(record(value, n), 1);
    ingest(item(), 10);
    expect(
      sessionActivityDetail([row(1)], service.queries.snapshot(), "a", id(1))
        .records,
    ).toHaveLength(1);
    ingest(conflict, 11);
    ingest(item(), 12);
    expect(
      sessionActivityDetail([row(1)], service.queries.snapshot(), "a", id(1))
        .records,
    ).toHaveLength(0);
    stop();
    expect(service.queries.snapshot().records).toHaveLength(0);
    service.dispose();
  }
});

it("post-terminal reuse of the identical tuple omits both lifecycles until a generation reset", () => {
  vi.useFakeTimers();
  const observe = vi.fn();
  const service = createAgentActivity(true, observe, () => true);
  const stop = service.queries.activate();
  const ingest = (value: unknown, n: number) =>
    service.receive(record(value, n), observe.mock.lastCall?.[0] as number);
  const detail = () =>
    sessionActivityDetail([row(1)], service.queries.snapshot(), "a", id(1));
  ingest(item(), 10);
  ingest(item({ kind: "turn_completed" }), 11);
  expect(detail().records).toHaveLength(2);
  ingest(item(), 12);
  ingest(item({ kind: "acp_read" }), 13);
  expect(service.queries.snapshot().turns[0]).toMatchObject({
    state: "ended",
    triggeringEventIds: undefined,
  });
  expect(detail().records).toHaveLength(0);
  service.clear();
  expect(service.queries.snapshot().records).toHaveLength(0);
  ingest(item(), 14);
  expect(detail().records.map((record) => record.envelopeId)).toEqual([id(14)]);
  stop();
  service.dispose();
});
