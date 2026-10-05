import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  matchedSessionTurns,
  type MatchedSessionTurn,
} from "./session-activity";

export const DETAIL_RECORD_LIMIT = 100;
export const DETAIL_BYTE_LIMIT = 256 * 1024;
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
export type SessionActivityRecord = Readonly<{
  id: string;
  envelopeId: string;
  kind: string;
  plaintext: string;
  projected: boolean;
  turn: MatchedSessionTurn;
}>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Join retained folded turns, never raw trigger payloads. Missing/poisoned/evicted
 * turns cannot be revived by retained plaintext. Child scope is always explicit. */
export function sessionActivityDetail(
  rows: readonly Pick<
    ChannelMessage,
    "id" | "channelId" | "threadRootId" | "delivery"
  >[],
  snapshot: Snapshot,
  channelId: string,
  rootId: string,
): Readonly<{ records: readonly SessionActivityRecord[]; trimmed: number }> {
  const turns = new Map(
    matchedSessionTurns(rows, snapshot.turns)
      .filter((turn) => turn.channelId === channelId && turn.rootId === rootId)
      .map((turn) => [
        JSON.stringify([turn.agent, turn.turnId, turn.channelId]),
        turn,
      ]),
  );
  const records: SessionActivityRecord[] = [];
  let bytes = 0,
    trimmed = 0;
  if (!turns.size) return { records, trimmed };
  const encoder = new TextEncoder();
  for (const record of snapshot.records) {
    // Archived executions may reuse a live turn's tuple; they are not live evidence.
    if (record.historical) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(record.plaintext);
    } catch {
      continue;
    }
    const envelope = object(raw);
    const batch = envelope?.kind === "batch";
    const children = batch ? object(envelope.payload)?.events : undefined;
    const items = batch ? (Array.isArray(children) ? children : []) : [raw];
    for (const [index, value] of items.entries()) {
      const item = object(value);
      if (
        !item ||
        item.kind === "batch" ||
        !text(item.kind) ||
        !text(item.turnId) ||
        !text(item.channelId)
      )
        continue;
      const turn = turns.get(
        JSON.stringify([record.agent, item.turnId, item.channelId]),
      );
      if (!turn) continue;
      const plaintext = batch ? JSON.stringify(item) : record.plaintext;
      const size = encoder.encode(plaintext).length;
      if (
        records.length >= DETAIL_RECORD_LIMIT ||
        bytes + size > DETAIL_BYTE_LIMIT
      ) {
        trimmed++;
        continue;
      }
      bytes += size;
      records.push({
        id: batch ? `${record.id}:${index}` : record.id,
        envelopeId: record.id,
        kind: item.kind,
        plaintext,
        projected: batch,
        turn,
      });
    }
  }
  return { records, trimmed };
}
