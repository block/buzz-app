import {
  incomingActivityMessage,
  outgoingActivityMessage,
  type ActivityMessage,
} from "./activity-message";
import { sendReport } from "./send-boundary";
import type { ActivityRecord } from "../../features/agents/activity-records";
import { activityErrorText } from "./failed-activity";

// Presentation only: rebuilt from the current RAM window, never another journal.
export const TRANSCRIPT_EVENT_LIMIT = 500;
type ObjectValue = { [key: string]: unknown };
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const identity = (value: unknown) => {
  const result = text(value);
  return result.length <= 256 ? result : "";
};
const json = (value: unknown) =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

/** ACP text blocks only. Never interpret prompt prose as identity or markup. */
function contentText(value: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (Array.isArray(value))
    return value
      .map((part) => {
        const block = object(part);
        return contentText(block?.content ?? block, depth + 1);
      })
      .filter(Boolean)
      .join("\n");
  const block = object(value);
  return block?.type === "text" ? text(block.text) : "";
}
export type TranscriptEntry = {
  id: string;
  kind: "prompt" | "message" | "thought" | "tool" | "plan" | "event";
  title: string;
  body: string;
  input: string;
  output: string;
  status: string;
  toolName?: string;
  communication?: ActivityMessage;
  diagnostic?: boolean;
  chunkKey?: string;
  /** References into the current raw projection, not another copy of telemetry. */
  sourceIds: string[];
};
export type TranscriptGroup = {
  id: string;
  agent: string;
  channelId: string | null;
  turnId: string | null;
  sessionId: string | null;
  receivedAt: number;
  entries: TranscriptEntry[];
};
type Item = { record: ActivityRecord; value: ObjectValue; id: string };
const toolStatuses = new Set(["pending", "in_progress", "completed", "failed"]);
const terminal = (status: string) =>
  status === "completed" || status === "failed";

export function activityTranscript(records: readonly ActivityRecord[]) {
  const events: Item[] = [];
  let total = 0;
  // Iterate newest-first so only the bounded display window is allocated.
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (!record) continue;
    let value: ObjectValue | undefined;
    try {
      value = object(JSON.parse(record.plaintext));
    } catch {
      /* raw view remains */
    }
    const children =
      value?.kind === "batch" && record.id === record.envelopeId
        ? object(value.payload)?.events
        : undefined;
    const values = Array.isArray(children) ? children : [value];
    for (let child = values.length - 1; child >= 0; child--) {
      const item = object(values[child]);
      if (!item) continue;
      total++;
      if (events.length < TRANSCRIPT_EVENT_LIMIT)
        events.push({
          record,
          value: item,
          id: Array.isArray(children) ? `${record.id}:${child}` : record.id,
        });
    }
  }
  const sources = new Map(events.map((item) => [item.id, item]));
  const groups = new Map<string, TranscriptGroup>();
  const tools = new Map<string, TranscriptEntry>();
  const chunks = new Map<string, TranscriptEntry>();
  const control = new Map<
    string,
    {
      title: string;
      diagnostic: boolean;
      entry: TranscriptEntry;
      options?: Map<string, string>;
    }
  >();
  const ambiguousControl = new Map<string, number>();
  const sourceOrder = new Map(events.map((item, index) => [item.id, -index]));
  for (const { record, value, id } of events.reverse()) {
    // Never inherit context from an enclosing batch or adjacent event.
    const channelId = identity(value.channelId) || null;
    const turnId = identity(value.turnId) || null;
    const sessionId = identity(value.sessionId) || null;
    // A turn may resolve its session mid-run; the turn itself remains the group.
    const key = JSON.stringify([
      record.agent,
      channelId,
      turnId ? ["turn", turnId] : ["record", id],
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        agent: record.agent,
        channelId,
        turnId,
        sessionId,
        receivedAt: record.receivedAt,
        entries: [],
      };
      groups.set(key, group);
    }
    const kind = text(value.kind);
    const payload = object(value.payload);
    const entry: TranscriptEntry = {
      id,
      kind: "event",
      title: "Other activity",
      body: "",
      input: "",
      output: "",
      status: "",
      sourceIds: [id],
    };
    const method = text(payload?.method);
    const params = object(payload?.params);
    const priorChunk = chunks.get(key);
    chunks.delete(key);
    const rpcScope = JSON.stringify([
      record.agent,
      channelId,
      turnId,
      sessionId,
    ]);
    const rpcId =
      typeof payload?.id === "string" || typeof payload?.id === "number"
        ? JSON.stringify([
            rpcScope,
            kind === "acp_read" ? "acp_write" : "acp_read",
            payload.id,
          ])
        : undefined;
    const setup =
      kind === "acp_write" &&
      ["initialize", "session/new", "session/load"].includes(method);
    const permission =
      kind === "acp_read" && method === "session/request_permission";
    const replyKey =
      typeof payload?.id === "string" || typeof payload?.id === "number"
        ? JSON.stringify([rpcScope, kind, payload.id])
        : undefined;
    if (
      !method &&
      replyKey &&
      (payload?.result !== undefined || payload?.error !== undefined)
    ) {
      const outstanding = ambiguousControl.get(replyKey);
      if (outstanding === 1) ambiguousControl.delete(replyKey);
      else if (outstanding) ambiguousControl.set(replyKey, outstanding - 1);
    }
    const reply = !method && replyKey ? control.get(replyKey) : undefined;
    if (setup || permission) {
      entry.title = permission
        ? "Permission requested"
        : method === "initialize"
          ? "Initialize agent"
          : "Prepare session";
      entry.diagnostic = setup;
      if (rpcId) {
        if (control.has(rpcId) || ambiguousControl.has(rpcId)) {
          const outstanding = ambiguousControl.get(rpcId) ?? 1;
          control.delete(rpcId);
          ambiguousControl.set(rpcId, outstanding + 1);
        } else {
          const options = new Map<string, string>();
          let valid =
            permission &&
            Array.isArray(params?.options) &&
            params.options.length > 0;
          if (Array.isArray(params?.options))
            for (const value of params.options) {
              const option = object(value);
              if (
                !identity(option?.optionId) ||
                ![
                  "allow_once",
                  "allow_always",
                  "reject_once",
                  "reject_always",
                ].includes(text(option?.kind)) ||
                options.has(text(option?.optionId))
              )
                valid = false;
              else options.set(text(option?.optionId), text(option?.kind));
            }
          control.set(rpcId, {
            title: permission
              ? "Permission response"
              : "Session setup response",
            diagnostic: setup,
            entry,
            ...(valid ? { options } : {}),
          });
        }
      }
    } else if (
      reply &&
      (payload?.result !== undefined || payload?.error !== undefined)
    ) {
      if (replyKey) control.delete(replyKey);
      if (reply.title === "Permission response" && reply.options) {
        const outcome = object(object(payload?.result)?.outcome);
        const option = reply.options.get(text(outcome?.optionId));
        const allowed =
          payload?.error === undefined &&
          outcome?.outcome === "selected" &&
          (option === "allow_once" || option === "allow_always");
        const denied =
          outcome?.outcome === "selected" &&
          (option === "reject_once" || option === "reject_always");
        if (
          allowed ||
          denied ||
          outcome?.outcome === "cancelled" ||
          payload?.error !== undefined
        ) {
          reply.entry.title = allowed
            ? "Permission allowed"
            : denied
              ? "Permission denied"
              : payload?.error !== undefined
                ? "Permission error"
                : "Permission cancelled";
          reply.entry.diagnostic = allowed;
          reply.entry.sourceIds.push(id);
          continue;
        }
      }
      entry.title =
        payload?.error !== undefined ? `${reply.title} error` : reply.title;
      entry.diagnostic = reply.diagnostic && payload?.error === undefined;
    } else if (kind === "prompt_context_delivery") {
      entry.title = "Context delivered";
      entry.diagnostic = true;
    } else if (kind === "agent_initialized") {
      entry.title = "Agent initialized";
      entry.diagnostic = true;
    } else if (
      kind === "acp_write" &&
      [
        "session/prompt",
        "_goose/unstable/session/steer",
        "_session/steering",
      ].includes(method)
    ) {
      entry.kind = "prompt";
      entry.title =
        method === "session/prompt" ? "Request context" : "Follow-up context";
      entry.diagnostic = true;
      entry.body = contentText(params?.prompt);
      const message = incomingActivityMessage(entry.body, channelId);
      if (message) {
        sourceOrder.set(`${id}:message`, sourceOrder.get(id) ?? -Infinity);
        group.entries.push({
          ...entry,
          id: `${id}:message`,
          kind: "message",
          title: "Incoming message",
          body: message.body,
          diagnostic: false,
          communication: message,
        });
      }
    } else if (
      kind === "acp_read" &&
      (method === "session/update" ||
        method === "_goose/unstable/session/update")
    ) {
      const update = object(params?.update);
      const updateKind = text(update?.sessionUpdate);
      if (["session_info_update", "usage_update"].includes(updateKind)) {
        entry.title =
          updateKind === "usage_update" ? "Usage update" : "Session update";
        entry.diagnostic = true;
      } else if (
        method === "session/update" &&
        (updateKind === "tool_call" || updateKind === "tool_call_update")
      ) {
        const toolId = identity(update?.toolCallId);
        const toolKey = JSON.stringify([
          key,
          identity(params?.sessionId) || sessionId,
          toolId,
        ]);
        const previous = toolId ? tools.get(toolKey) : undefined;
        const tool = previous ?? entry;
        tool.kind = "tool";
        tool.title =
          text(update?.title) || (previous ? tool.title : "Tool call");
        if (text(update?.title) && !tool.toolName)
          tool.toolName = text(update?.title);
        const status = text(update?.status);
        if (
          toolStatuses.has(status) &&
          (!terminal(tool.status) || status === "failed")
        )
          tool.status = status;
        if (update?.rawInput !== undefined) tool.input = json(update.rawInput);
        // Tool updates are snapshots; unlike message chunks, output is not appended.
        const output =
          contentText(update?.content) ||
          (update?.rawOutput !== undefined ? json(update.rawOutput) : "");
        if (update?.content !== undefined || update?.rawOutput !== undefined)
          tool.output = output;
        const report =
          tool.toolName === "buzz-dev-mcp__shell" && update
            ? sendReport(update)
            : undefined;
        const priorReceipt = tool.communication?.eventId;
        const outputChanged =
          update?.content !== undefined || update?.rawOutput !== undefined;
        const reportedId =
          report?.messageId && priorReceipt && report.messageId !== priorReceipt
            ? undefined
            : (report?.messageId ??
              (!outputChanged ? priorReceipt : undefined));
        const reportedAudience = reportedId
          ? report?.messageId === reportedId
            ? report.reportedAudience
            : !outputChanged
              ? tool.communication?.reportedAudience
              : undefined
          : undefined;
        const message = outgoingActivityMessage(
          tool,
          record.agent,
          reportedId,
          reportedAudience,
        );
        if (message) tool.communication = message;
        else delete tool.communication;
        if (previous) {
          if (!tool.sourceIds.includes(id)) tool.sourceIds.push(id);
          continue;
        }
        if (toolId) tools.set(toolKey, tool);
      } else if (
        [
          "agent_message_chunk",
          "agent_thought_chunk",
          "user_message_chunk",
        ].includes(updateKind)
      ) {
        entry.kind =
          updateKind === "agent_thought_chunk"
            ? "thought"
            : updateKind === "user_message_chunk"
              ? "prompt"
              : "message";
        entry.title =
          entry.kind === "thought"
            ? "Thinking"
            : entry.kind === "prompt"
              ? "Prompt echo"
              : "Response";
        entry.body = contentText(update?.content);
        // An echo cannot establish another authored message; keep it in context.
        if (entry.kind === "prompt") entry.diagnostic = true;
        // Only contiguous chunks within this exact turn and message may coalesce.
        const previous = priorChunk;
        const chunkKey = JSON.stringify([
          key,
          identity(params?.sessionId) || sessionId,
          identity(update?.messageId),
          updateKind,
        ]);
        chunks.set(key, previous?.chunkKey === chunkKey ? previous : entry);
        if (previous?.chunkKey === chunkKey) {
          previous.body += entry.body;
          if (!previous.sourceIds.includes(id)) previous.sourceIds.push(id);
          continue;
        }
        entry.chunkKey = chunkKey;
      } else if (updateKind === "plan" && Array.isArray(update?.entries)) {
        entry.kind = "plan";
        entry.title = "Plan";
        entry.body = update.entries
          .map((value) => {
            const item = object(value);
            return text(item?.content)
              ? `${item?.status === "completed" ? "✓" : "•"} ${text(item?.content)}`
              : "";
          })
          .filter(Boolean)
          .join("\n");
      } else {
        entry.title = updateKind || "Activity update";
      }
    } else if (kind === "turn_completed") {
      entry.title = "Turn ended";
    } else if (kind === "turn_error" || kind === "agent_panic") {
      entry.title = "Turn error";
      entry.body = activityErrorText(payload);
    } else if (
      ["turn_liveness", "turn_started", "session_resolved"].includes(kind)
    ) {
      // These provide group context, not repetitive reading rows or success claims.
      continue;
    }
    group.entries.push(entry);
  }
  return {
    groups: [...groups.values()],
    // Folded tool/chunk rows keep display position; source order tracks later updates.
    sourceOrder,
    omitted: Math.max(0, total - TRANSCRIPT_EVENT_LIMIT),
    /** JSON is serialized on disclosure only. Mixed batch parents are never used. */
    source: (id: string) => {
      const item = sources.get(id);
      return item
        ? {
            envelopeId: item.record.envelopeId,
            plaintext:
              item.id === item.record.id
                ? item.record.plaintext
                : json(item.value),
          }
        : undefined;
    },
  };
}
