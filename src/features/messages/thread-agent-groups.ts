import type { ChannelMessage } from "../relay/contracts";
import type { pendingAgentRequest } from "./agent-request";

export type ThreadAgentBlock = {
  kind: "agents";
  id: string;
  rows: ChannelMessage[];
  agents: string[];
  request?: ReturnType<typeof pendingAgentRequest>;
  tail: boolean;
};
export type ThreadReplyBlock =
  | ThreadAgentBlock
  | { kind: "message"; row: ChannelMessage };

/** Display intent only, never ownership, delivery or finality. */
export function isAgentCoordination(
  row: ChannelMessage,
  known: ReadonlySet<string>,
  viewer?: string,
) {
  return (
    row.audience === "agents" &&
    row.authorId !== viewer &&
    !row.membership &&
    (row.agentEnvelope === true || known.has(row.authorId))
  );
}

/** Presentation of contiguous rows, not request/reply causality. Human, unknown
 * and membership rows are boundaries and are never moved into an agent block.
 * Only an explicit original audience=agents declaration admits coordination;
 * ordinary/legacy replies remain visible, regardless of wording or finality. */
export function threadAgentGroups(
  root: ChannelMessage | undefined,
  replies: readonly ChannelMessage[],
  known: ReadonlySet<string>,
  request: ReturnType<typeof pendingAgentRequest>,
  viewer?: string,
  visibleAncestors: ReadonlySet<string> = new Set(),
): ThreadReplyBlock[] {
  const result: ThreadReplyBlock[] = [];
  let boundary = root;
  let rows: ChannelMessage[] = [];
  const flush = (tail: boolean) => {
    const pending = request?.message.id === boundary?.id ? request : undefined;
    const agents = [
      ...new Set([
        ...(boundary?.mentions.filter((key) => known.has(key)) ?? []),
        ...rows.map((row) => row.authorId),
        ...(pending?.agents ?? []),
      ]),
    ].sort();
    if (rows.length || pending) {
      result.push({
        kind: "agents",
        id: boundary?.id ?? "unavailable-root",
        rows,
        agents,
        request: pending,
        tail,
      });
    }
    rows = [];
  };
  for (const row of replies) {
    if (
      isAgentCoordination(row, known, viewer) &&
      !visibleAncestors.has(row.id)
    ) {
      rows.push(row);
    } else {
      flush(false);
      result.push({ kind: "message", row });
      boundary = row;
    }
  }
  flush(true);
  return result;
}
