import type { ActivityRecord } from "../../features/agents/activity-records";
import { activityRecords } from "../../features/agents/activity-records";
import { reportedSend, sendReport } from "./send-boundary";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
type Item = { row: ActivityRecord; raw: Record<string, unknown>; seq: number };
export type ResponseActivity =
  | { status: "available"; records: readonly ActivityRecord[]; turnId: string }
  | {
      status: "unavailable";
      records: readonly ActivityRecord[];
      reason?: "not-retained";
    };
const unavailable: ResponseActivity = Object.freeze({
  status: "unavailable",
  records: [],
});

/** Best-effort interval ending at an exact tool-reported send, not a causal or
 * complete transcript. Rebuilt only when opened, from current retained evidence.
 * Never promotes telemetry to message/authorization evidence or guesses by time. */
export function responseActivity(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channel: string,
  messageId: string,
): ResponseActivity {
  return selectActivity(records, agent, channel, messageId, false);
}

/** Exact reported output -> retained producer turn. Multiple sends in one tool
 * may share this turn, but never claim independently delimited reply intervals. */
export function reportedActivityTurn(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channel: string,
  messageId: string,
): string | undefined {
  const selected = selectActivity(records, agent, channel, messageId, true);
  return selected.status === "available" ? selected.turnId : undefined;
}
function selectActivity(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channel: string,
  messageId: string,
  wholeTurn: boolean,
): ResponseActivity {
  if (!/^[0-9a-f]{64}$/.test(messageId)) return unavailable;
  const scoped = activityRecords(records, agent, channel);
  if (!scoped.length)
    return { status: "unavailable", records: [], reason: "not-retained" };
  const groups = new Map<string, Item[]>();
  const invalid = new Set<string>();
  let targetReports = 0;
  for (const row of scoped) {
    let raw: Record<string, unknown> | undefined;
    try {
      raw = object(JSON.parse(row.plaintext));
    } catch {
      continue;
    }
    const payload = object(raw?.payload);
    const update = object(object(payload?.params)?.update);
    if (
      raw?.kind === "acp_read" &&
      payload?.method === "session/update" &&
      update
    )
      targetReports += sendReport(update).ids.filter(
        (value) => value === messageId,
      ).length;
    if (!raw || !id(raw.turnId)) continue;
    // The channel projection has already isolated batch children. Nested batches
    // are not another envelope; they cannot supply hidden association evidence.
    const turn = raw.turnId;
    if (
      raw.kind === "batch" ||
      !Number.isSafeInteger(raw.seq) ||
      Number(raw.seq) < 0
    ) {
      invalid.add(turn);
      continue;
    }
    const group = groups.get(turn) ?? [];
    group.push({ row, raw, seq: Number(raw.seq) });
    groups.set(turn, group);
  }
  if (targetReports !== 1) return unavailable;
  const matches: ResponseActivity[] = [];
  for (const [turnId, input] of groups) {
    if (invalid.has(turnId)) continue;
    const ordered = [...input].sort((a, b) => a.seq - b.seq);
    const targetIndex = ordered.findIndex(({ raw }) => {
      const update = object(object(object(raw.payload)?.params)?.update);
      return update && sendReport(update).ids.includes(messageId);
    });
    if (targetIndex < 0) continue;
    // Later unrelated tools cannot invalidate an already-closed response. The
    // global exact-ID check above still rejects later replay/conflicting reports.
    const items = ordered.slice(0, targetIndex + 1);
    if (
      items.some(
        (item, index) => index > 0 && items[index - 1]?.seq === item.seq,
      )
    )
      continue;
    const starts = items.filter((item) => item.raw.kind === "turn_started");
    // Without a retained beginning, an earlier send/tool could cross our left edge.
    if (starts.length !== 1 || starts[0] !== items[0]) continue;
    const tools = new Map<
      string,
      {
        start: number;
        update: Record<string, unknown>;
        ended: boolean;
        end?: number;
      }
    >();
    const boundaries: { index: number; message: string }[] = [];
    let bad = false;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item) continue;
      const payload = object(item.raw.payload);
      const params = object(payload?.params);
      const update = object(params?.update);
      if (
        item.raw.kind !== "acp_read" ||
        payload?.method !== "session/update" ||
        !update
      )
        continue;
      if (
        !["tool_call", "tool_call_update"].includes(
          String(update.sessionUpdate),
        )
      )
        continue;
      const sessionId = params?.sessionId ?? item.raw.sessionId;
      if (
        !id(sessionId) ||
        (id(params?.sessionId) &&
          id(item.raw.sessionId) &&
          params.sessionId !== item.raw.sessionId) ||
        !id(update.toolCallId)
      ) {
        bad = true;
        break;
      }
      const key = JSON.stringify([sessionId, update.toolCallId]);
      if (update.sessionUpdate === "tool_call") {
        if (tools.has(key)) {
          bad = true;
          break;
        }
        tools.set(key, { start: index, update, ended: false });
      }
      const tool = tools.get(key);
      if (
        tool &&
        update.sessionUpdate === "tool_call_update" &&
        ((update.title !== undefined && update.title !== tool.update.title) ||
          (update.rawInput !== undefined &&
            JSON.stringify(update.rawInput) !==
              JSON.stringify(tool.update.rawInput)))
      ) {
        bad = true;
        break;
      }
      if (!tool || tool.ended) {
        bad = true;
        break;
      }
      if (update.status !== "completed" && update.status !== "failed") continue;
      tool.ended = true;
      tool.end = index;
      const report = sendReport(update);
      const send = reportedSend(tool.update, update);
      const messages =
        wholeTurn && tool.update.title === "buzz-dev-mcp__shell"
          ? report.messageIds
          : send && send !== "ambiguous"
            ? [send.messageId]
            : [];
      if (send === "ambiguous" && !messages.length) {
        bad = true;
        break;
      }
      for (const message of messages) boundaries.push({ index, message });
    }
    if (bad) continue;
    const candidates = boundaries.filter(
      (boundary) => boundary.message === messageId,
    );
    if (candidates.length !== 1) {
      if (candidates.length > 1) return unavailable;
      continue;
    }
    const target = candidates[0];
    if (!target) continue;
    const boundaryIndex = boundaries.indexOf(target);
    const left = wholeTurn ? -1 : (boundaries[boundaryIndex - 1]?.index ?? -1);
    // Do not divide a tool's start/result across responses. Concurrent complete
    // tools wholly inside the interval are retained without claiming causality.
    if (
      [...tools.values()].some(
        (tool) =>
          tool.start <= target.index &&
          (tool.end === undefined ||
            tool.end > target.index ||
            (tool.start <= left && tool.end > left)),
      )
    )
      continue;
    matches.push({
      status: "available",
      turnId,
      records: items.slice(left + 1, target.index + 1).map((item) => item.row),
    });
  }
  return matches.length === 1 ? (matches[0] ?? unavailable) : unavailable;
}
