import {
  activityRecords,
  type ActivityRecord,
} from "../../features/agents/activity-records";

type PreviewItem = {
  id: string;
  label: string;
  text: string;
  timestamp: number;
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const clipped = (value: string) =>
  value.length > 600 ? `…${value.slice(-600)}` : value;

/** A small display projection, not a transcript store. Only explicit assistant
 * ACP message text and tool titles are shown; prompts, thoughts, arguments and
 * raw results stay out of this preview. Mixed batches are scoped before parsing. */
export function activityPreview(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channelId: string,
): PreviewItem[] {
  if (!channelId) return [];
  const items = new Map<string, PreviewItem>();
  for (const row of activityRecords(records, agent, channelId)) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.plaintext);
    } catch {
      continue;
    }
    const event = object(raw);
    const payload = object(event.payload);
    if (event.kind !== "acp_read" || payload.method !== "session/update")
      continue;
    const update = object(object(payload.params).update);
    const kind = update.sessionUpdate;
    const scope = [text(event.sessionId), text(event.turnId)];
    const parsed = Date.parse(text(event.timestamp));
    const timestamp =
      Number.isFinite(parsed) && parsed <= row.receivedAt + 5000
        ? parsed
        : row.receivedAt;
    let id: string;
    let label: string;
    let content: string;
    if (kind === "agent_message_chunk") {
      const block = object(update.content);
      if (block.type !== "text" || !text(block.text)) continue;
      // Without a message or turn identity, don't join unrelated chunks.
      id = JSON.stringify([
        ...scope,
        "message",
        text(update.messageId) || text(event.turnId) || row.id,
      ]);
      label = "Assistant";
      content = clipped((items.get(id)?.text ?? "") + text(block.text));
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      if (!text(update.toolCallId)) continue;
      id = JSON.stringify([...scope, "tool", update.toolCallId]);
      const previous = items.get(id);
      content = clipped(text(update.title) || previous?.text || "Tool call");
      label =
        update.status === "completed"
          ? "Tool completed"
          : update.status === "failed"
            ? "Tool error"
            : update.status === "in_progress"
              ? "Using tool"
              : update.status === "pending"
                ? "Tool pending"
                : previous?.label || "Tool";
    } else continue;
    // Preserve interleaved chunks while folding the bounded journal; return only
    // the three most recently updated items.
    items.delete(id);
    items.set(id, { id, label, text: content, timestamp });
  }
  return [...items.values()].slice(-3);
}
