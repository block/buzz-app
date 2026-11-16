// A remote agent's stored sessions as the host's turn-transcript model.
// Builderlab keeps the messages; nothing here writes or keeps them.
import { isMessageTool } from "../../../buzz-mcp/message-tools";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../../features/agents/activity-transcript";
import { terminalOutcome } from "../../../features/agents/observer";
import type { AgentClient, AgentSession } from "../agents/client";
import type { BuilderlabSession } from "../session";

type Json = Record<string, unknown>;
type Names = (pubkey: string) => string | undefined;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const list = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = object(entry);
    return item ? [item] : [];
  });
const str = (value: unknown) => (typeof value === "string" ? value : "");
const millis = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? number
    : undefined;
};
/** Protobuf JSON names an enum, or may send its number. */
const enumName = (value: unknown, names: readonly string[]) =>
  typeof value === "number" ? (names[value] ?? "") : str(value);
const ROLES = ["ROLE_UNSPECIFIED", "ROLE_USER", "ROLE_ASSISTANT"];
const STATUSES = [
  "TASK_STATUS_UNSPECIFIED",
  "TASK_STATUS_INITIALIZED",
  "TASK_STATUS_RUNNING",
  "TASK_STATUS_COMPLETED",
  "TASK_STATUS_FAILED",
  "TASK_STATUS_CANCELLED",
  "TASK_STATUS_TERMINATED",
];
const SUMMARY = 5;
/** The prompt composer escapes these in every value it writes. */
const decodeEntities = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The composer follows a sender with whether they are the owner. */
const OWNER_NOTE = /\. This sender .*$/;
/** Tool results are text, or other content shown as JSON. */
const resultText = (results: unknown) =>
  list(results)
    .map((result) => {
      const text = object(result.text);
      return text ? str(text.text) : JSON.stringify(result, null, 2);
    })
    .filter(Boolean)
    .join("\n");

function prompt(id: string, at: number, raw: string, name?: Names) {
  const sections = promptSections(raw);
  const { text, author, authorPubkey } = promptMessage(sections, name);
  const item: TranscriptItem = {
    id,
    at,
    type: "prompt",
    text: text ? decodeEntities(text) : raw,
    ...(author
      ? { author: decodeEntities(author).replace(OWNER_NOTE, "") }
      : {}),
    ...(authorPubkey ? { authorPubkey } : {}),
    sections,
    steer: sections.some((section) => section.tag === STEER),
  };
  return item;
}

/** A stored session's turns, oldest first. Messages carry no turn, so each
 * belongs to the latest turn started at or before it. */
export function sessionTurns(
  session: AgentSession,
  response: Json,
  name?: Names,
): TranscriptTurn[] {
  const turns = list(response.turns)
    .flatMap((row): TranscriptTurn[] => {
      const turnId = str(row.turn_id);
      const startedAt = millis(row.created_at);
      if (!turnId || startedAt === undefined) return [];
      const status = enumName(row.status, STATUSES).replace("TASK_STATUS_", "");
      const outcome = terminalOutcome("turn_completed", status.toLowerCase());
      const ended = outcome && outcome !== "unknown";
      const updatedAt = millis(row.updated_at);
      const mention = str(row.mention_event_id);
      return [
        {
          turnId,
          channelId: session.channelId,
          threadRootId: session.threadRootId ?? null,
          triggeringEventIds: mention ? [mention] : [],
          sessionId: session.sessionId,
          newSession: false,
          config: [],
          startedAt,
          ...(ended
            ? { outcome, endedAt: Math.max(updatedAt ?? startedAt, startedAt) }
            : {}),
          partial: false,
          items: [],
        },
      ];
    })
    .sort((a, b) => a.startedAt - b.startedAt);
  if (turns[0]) turns[0].newSession = true;
  const tools = new Map<string, ToolItem>();
  const sends = new Map<string, { posted?: boolean }>();
  for (const message of list(response.messages)) {
    const at = millis(message.created);
    const id = str(message.id);
    if (message.deleted === true || at === undefined || !id) continue;
    const turn =
      [...turns].reverse().find((candidate) => candidate.startedAt <= at) ??
      turns[0];
    if (!turn) break;
    const role = enumName(message.role, ROLES);
    const error = object(message.llm_call_error_info);
    if (error?.is_error === true)
      turn.error = str(error.cause) || "The model call failed.";
    list(message.content).forEach((content, index) => {
      const key = `${id}:${index}`;
      const text = str(object(content.text)?.text);
      const request = object(content.tool_request);
      const response = object(content.tool_response);
      if (response) {
        const callId = str(response.id);
        const failed = str(response.status) === "error";
        const sent = sends.get(callId);
        if (sent && !failed) sent.posted = true;
        const tool = tools.get(callId);
        if (!tool) return;
        tool.output = str(response.error) || resultText(response.results);
        tool.status = failed ? "failed" : "completed";
        tool.completedAt = at;
      } else if (request) {
        const call = object(request.value);
        const title = str(call?.name);
        const input = str(call?.arguments);
        const callId = str(request.id);
        let args: Json | undefined;
        try {
          args = object(JSON.parse(input));
        } catch {}
        const posted = /^(?:mcp__)?buzz__(\w+)$/.exec(title)?.[1];
        if (posted && isMessageTool(posted) && str(args?.text).trim()) {
          const message: TranscriptItem & { posted?: boolean } = {
            id: key,
            at,
            type: "message",
            text: str(args?.text),
          };
          turn.items.push(message);
          sends.set(callId, message);
          return;
        }
        const path = str(args?.path) || str(args?.file_path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: callId,
          title: title || "Tool",
          kind: "other",
          status: str(request.error) ? "failed" : "in_progress",
          input: args ? JSON.stringify(args, null, 2) : input,
          output: str(request.error),
          diffs: [],
          paths: path ? [path] : [],
          truncated: false,
        };
        tools.set(callId, tool);
        turn.items.push(tool);
      } else if (
        content.type === "MESSAGE_TYPE_SUMMARY" ||
        content.type === SUMMARY
      ) {
        turn.items.push({
          id: key,
          at,
          type: "status",
          text: "Earlier messages were summarized.",
        });
      } else if (object(content.thinking)) {
        const thought = str(object(content.thinking)?.thinking);
        if (thought.trim())
          turn.items.push({ id: key, at, type: "thought", text: thought });
      } else if (text.trim()) {
        if (role === "ROLE_USER") turn.items.push(prompt(key, at, text, name));
        else turn.items.push({ id: key, at, type: "message", text });
      }
    });
  }
  return turns;
}

/** Stored sessions read at most for one view, most recently active first. */
export const SESSION_LIMIT = 5;
export type StoredSession = Readonly<{ session: AgentSession; response: Json }>;
export type StoredHistory =
  | Readonly<{ status: "loaded"; sessions: StoredSession[]; more: boolean }>
  | Readonly<{ status: "signed-out" | "unsupported" }>;
export type HistoryReader = (
  pubkey: string,
  scope: Readonly<{ channelId?: string; rootId?: string }>,
  signal: AbortSignal,
) => Promise<StoredHistory>;

const notFound = (error: unknown) =>
  error instanceof Error && "status" in error && error.status === 404;

/** Reads the signed-in owner's stored sessions of an agent for a view: one
 * conversation (its thread's session and its channel's shared one), or all. */
export function historyReader(
  client: AgentClient,
  session: BuilderlabSession,
): HistoryReader {
  return async (pubkey, { channelId, rootId }, signal) => {
    const login = session.snapshot();
    if (login.status !== "signed-in" || !login.account?.canUseRemoteAgents)
      return { status: "signed-out" };
    const agent = (await client.list(signal)).find(
      (row) => row.pubkey === pubkey,
    );
    if (!agent) return { status: "loaded", sessions: [], more: false };
    let listed: Awaited<ReturnType<AgentClient["sessions"]>>;
    try {
      listed = await client.sessions(agent.id, signal);
    } catch (error) {
      // A Builderlab without stored sessions has no such route.
      if (notFound(error)) return { status: "unsupported" };
      throw error;
    }
    const matching = listed.sessions.filter(
      (stored) =>
        !channelId ||
        (stored.channelId === channelId &&
          (!stored.threadRootId || !rootId || stored.threadRootId === rootId)),
    );
    const sessions = await Promise.all(
      matching.slice(0, SESSION_LIMIT).map(async (stored) => {
        try {
          return [
            {
              session: stored,
              response: await client.sessionMessages(stored.sessionId, signal),
            },
          ];
        } catch (error) {
          // Ended or replaced since it was listed.
          if (notFound(error)) return [];
          throw error;
        }
      }),
    );
    return {
      status: "loaded",
      sessions: sessions.flat(),
      more: listed.more || matching.length > SESSION_LIMIT,
    };
  };
}

/** Turns from stored sessions; a removed session's are withheld. */
export const storedTurns = (sessions: readonly StoredSession[], name?: Names) =>
  sessions.flatMap((stored) =>
    stored.response.removal_state
      ? []
      : sessionTurns(stored.session, stored.response, name),
  );

/** Live turns, with stored ones Buzz did not see. A live turn that began
 * before Buzz saw it is partial, so its stored copy shows instead. */
export function mergeTurns(
  live: readonly TranscriptTurn[],
  stored: readonly TranscriptTurn[],
): TranscriptTurn[] {
  const saved = new Map(stored.map((turn) => [turn.turnId, turn]));
  const shown = new Set<string>();
  const turns = live.map((turn): TranscriptTurn => {
    shown.add(turn.turnId);
    const copy = saved.get(turn.turnId);
    if (!turn.partial || !copy) return turn;
    return turn.outcome ? { ...copy, outcome: turn.outcome } : copy;
  });
  for (const turn of stored) if (!shown.has(turn.turnId)) turns.push(turn);
  return turns.sort((a, b) => a.startedAt - b.startedAt);
}
