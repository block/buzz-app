import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import {
  activityRecords,
  type ActivityRecord,
} from "../../features/agents/activity-records";
import { activityTranscript } from "./transcript";
import { requestActivity, requestActivityState } from "./request-activity";
import { responseActivity } from "./response-activity";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Node = {
  key: string;
  agent: string;
  turnId: string;
  triggers: string[];
  records: ActivityRecord[];
  valid: boolean;
  start: number;
  end?: number;
};
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = (raw: { timestamp?: unknown }, row: ActivityRecord) => {
  const time =
    typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  return Number.isFinite(time) && time >= 0 && time <= row.receivedAt + 5000
    ? time
    : NaN;
};

/** Reported request lineage, not coauthorship or a complete effort history. Rebuilt
 * from bounded retained records and loaded signed messages; never proximity/prose. */
export function requestWork(
  snapshot: Snapshot,
  messages: readonly ChannelMessage[],
  channelId: string,
  rootId: string,
  viewer: string | undefined,
) {
  const rows = messages.filter(
    (row) =>
      row.channelId === channelId &&
      (row.id === rootId || row.threadRootId === rootId),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seeds = new Set(
    rows
      .filter(
        (row) => row.authorId === viewer && !row.membership && hex(row.id),
      )
      .map((row) => row.id),
  );
  const nodes: Node[] = [];
  const uncertainTriggers: string[][] = [];
  for (const agent of new Set(
    snapshot.records
      .filter((row) => row.channelIds.includes(channelId))
      .map((row) => row.agent),
  )) {
    const selected = requestActivity(
      snapshot.records,
      agent,
      channelId,
      rows.map((row) => row.id),
    );
    const scoped = activityRecords(snapshot.records, agent, channelId);
    for (const row of scoped) {
      const raw = JSON.parse(row.plaintext);
      if (
        raw.kind === "turn_started" &&
        !selected.turnIds.has(raw.turnId) &&
        Array.isArray(raw.payload?.triggeringEventIds)
      )
        uncertainTriggers.push(raw.payload.triggeringEventIds.filter(hex));
    }
    for (const turnId of selected.turnIds) {
      if (nodes.length >= 512) {
        uncertainTriggers.push(rows.map((row) => row.id));
        break;
      }
      const records = selected.records.filter(
        (row) => JSON.parse(row.plaintext).turnId === turnId,
      );
      const startRecord = records.find(
        (row) => JSON.parse(row.plaintext).kind === "turn_started",
      );
      if (!startRecord) continue;
      const raw = JSON.parse(startRecord.plaintext);
      const triggers: unknown = raw.payload?.triggeringEventIds;
      const start = timestamp(raw, startRecord);
      const valid =
        Array.isArray(triggers) &&
        triggers.length > 0 &&
        triggers.every(hex) &&
        Number.isFinite(start);
      const terminal = records
        .filter((row) =>
          ["turn_completed", "turn_error", "agent_panic"].includes(
            JSON.parse(row.plaintext).kind,
          ),
        )
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .find((row) =>
          Number.isFinite(timestamp(JSON.parse(row.plaintext), row)),
        );
      const end = terminal
        ? timestamp(JSON.parse(terminal.plaintext), terminal)
        : undefined;
      nodes.push({
        key: JSON.stringify([agent, turnId]),
        agent,
        turnId,
        records,
        triggers: Array.isArray(triggers) ? triggers.filter(hex) : [],
        valid,
        start: startRecord.receivedAt,
        ...(end !== undefined && terminal && end >= start
          ? { end: terminal.receivedAt }
          : {}),
      });
    }
  }
  // A loaded message proves existence/author; the strict send selector proves only
  // one retained report interval. Both are necessary to propagate a handoff.
  const producers = new Map<string, Node>();
  for (const agent of new Set(nodes.map((node) => node.agent))) {
    const ids = new Set(
      activityTranscript(
        snapshot.records
          .filter((row) => row.agent === agent)
          .map((row) => ({ ...row, envelopeId: row.id })),
      ).groups.flatMap((group) =>
        group.entries.flatMap((entry) =>
          entry.communication?.eventId ? [entry.communication.eventId] : [],
        ),
      ),
    );
    for (const id of ids) {
      const row = byId.get(id);
      if (
        !row ||
        row.authorId !== agent ||
        seeds.has(id) ||
        (row.delivery && row.delivery !== "seen")
      )
        continue;
      const response = responseActivity(snapshot.records, agent, channelId, id);
      if (response.status !== "available") continue;
      const node = nodes.find(
        (node) => node.agent === agent && node.turnId === response.turnId,
      );
      if (node) producers.set(id, node);
    }
  }
  const scopes = new Map<string, string | null>();
  const resolving = new Set<string>();
  function scope(node: Node): string | undefined {
    if (scopes.has(node.key)) return scopes.get(node.key) ?? undefined;
    if (resolving.has(node.key) || !node.valid) return undefined;
    resolving.add(node.key);
    const resolved = node.triggers.map((id) =>
      seeds.has(id)
        ? id
        : producers.get(id)
          ? scope(producers.get(id) as Node)
          : undefined,
    );
    resolving.delete(node.key);
    const unique = new Set(resolved);
    const result =
      !unique.has(undefined) && unique.size === 1 ? resolved[0] : undefined;
    scopes.set(node.key, result ?? null);
    return result;
  }
  for (const node of nodes) scope(node);
  return [...seeds].map((requestId) => {
    const linked = nodes.filter((node) => scopes.get(node.key) === requestId);
    const uncertain =
      snapshot.trimmed > 0 ||
      uncertainTriggers.some((triggers) =>
        triggers.some(
          (id) =>
            id === requestId ||
            scopes.get(producers.get(id)?.key ?? "") === requestId,
        ),
      ) ||
      nodes.some(
        (node) =>
          !scopes.get(node.key) &&
          node.triggers.some(
            (id) =>
              id === requestId ||
              (producers.has(id) &&
                scopes.get(producers.get(id)?.key ?? "") === requestId),
          ),
      );
    const agents = [...new Set(linked.map((node) => node.agent))]
      .sort()
      .map((agent) => {
        const records = linked
          .filter((node) => node.agent === agent)
          .flatMap((node) => node.records);
        const selected = requestActivity(
          records,
          agent,
          channelId,
          rows.map((row) => row.id),
        );
        const turns = snapshot.turns.filter(
          (turn) =>
            turn.agent === agent &&
            turn.channelId === channelId &&
            selected.turnIds.has(turn.turnId),
        );
        const state = requestActivityState(selected, turns, uncertain ? 1 : 0);
        const agentNodes = linked.filter((node) => node.agent === agent);
        const elapsed =
          state === "ended" &&
          agentNodes.every(
            (node) => node.end !== undefined && node.end >= node.start,
          )
            ? Math.max(...agentNodes.map((node) => node.end ?? node.start)) -
              Math.min(...agentNodes.map((node) => node.start))
            : undefined;
        return {
          agent,
          records,
          turns,
          state,
          // Ordering chooses a presentation anchor, never attribution. Hidden
          // coordination still participates in lineage; callers filter visibility.
          responseIds: rows
            .filter((row) => {
              const producer = producers.get(row.id);
              return (
                producer?.agent === agent &&
                scopes.get(producer.key) === requestId
              );
            })
            .map((row) => row.id),
          ...(elapsed !== undefined ? { elapsed } : {}),
        };
      });
    const state =
      agents.some((a) => a.state === "working") &&
      snapshot.status === "listening"
        ? "working"
        : uncertain || agents.some((a) => a.state === "unknown")
          ? "unknown"
          : agents.some((a) => a.state === "error")
            ? "error"
            : agents.length && agents.every((a) => a.state === "ended")
              ? "ended"
              : "waiting";
    const elapsed =
      state === "ended" &&
      linked.every((node) => node.end !== undefined && node.end >= node.start)
        ? Math.max(...linked.map((node) => node.end ?? node.start)) -
          Math.min(...linked.map((node) => node.start))
        : undefined;
    return {
      requestId,
      agents,
      state,
      uncertain,
      ...(elapsed !== undefined ? { elapsed } : {}),
    };
  });
}
export type RequestWork = ReturnType<typeof requestWork>[number];
export function elapsedWork(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
