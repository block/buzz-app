import {
  isMessageAudience,
  messageAudience,
  type MessageAudience,
} from "../../features/relay/message-audience";
import type { TranscriptEntry } from "./transcript";

export type ActivityMessage = {
  direction: "incoming" | "outgoing";
  body: string;
  author?: string;
  eventId?: string;
  channelId?: string;
  /** Telemetry report, not verification of the underlying signed message. */
  reportedAudience?: MessageAudience;
};
const hex = (value: string | undefined) =>
  value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
const channel = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function parsed(value: string) {
  try {
    return object(JSON.parse(value));
  } catch {
    return;
  }
}

/** Presentation from the pinned Buzz prompt envelope, not verified chat/ownership.
 * Context sections are never current messages. Ambiguous/multi-event captures stay raw.
 * Supports current semantic and old single-event bracket framing without parsing HTML. */
export function incomingActivityMessage(
  prompt: string,
  scope: string | null,
): ActivityMessage | undefined {
  const semantic = [
    ...prompt.matchAll(/^<buzz-event(?: type="[^"\r\n]*")?>\r?\n/gm),
  ];
  const bracket = [
    ...prompt.matchAll(/^\[Buzz event(?:: [^\]\r\n]+)?\]\r?\n/gm),
  ];
  if (
    semantic.length + bracket.length !== 1 ||
    /<(?:buzz-events|new-message-arrived-while-you-were-working|new-request-supersedes-previous)\b/.test(
      prompt,
    )
  )
    return;
  const start = semantic[0] ?? bracket[0];
  if (!start || start.index === undefined) return;
  let prefix = prompt.slice(0, start.index).trim();
  // A marker quoted inside prior context is not the current triggering event.
  if (semantic.length) {
    const section =
      /^<(base|workspace|agent-instructions|system|team-instructions|core-memory|channel-canvas|huddle-instructions|context|thread-context|conversation-context)(?: [^>\r\n]*)?>\r?\n[\s\S]*?\r?\n<\/\1>\s*/;
    prefix = prefix.replace(/^\/[^\r\n]+\r?\n/, "");
    while (prefix && section.test(prefix))
      prefix = prefix.replace(section, "").trimStart();
    if (prefix) return;
  }
  if (!semantic.length && prefix) return;
  const semanticMode = semantic.length === 1;
  const tail = prompt.slice(start.index + start[0].length);
  const close = semanticMode ? tail.indexOf("\n</buzz-event>") : -1;
  if (semanticMode && (close < 0 || tail.slice(close + 14).trim())) return;
  const body = close < 0 ? tail : tail.slice(0, close);
  const content = /^Content: ?/m.exec(body);
  if (!content || content.index === undefined) return;
  const header = body.slice(0, content.index);
  const ids = [...header.matchAll(/^Event ID: ([^\r\n]+)\r?$/gm)];
  const authors = [...header.matchAll(/^From: ([^\r\n]+)\r?$/gm)];
  const scopes = [...header.matchAll(/^Channel: ([^\r\n]+)\r?$/gm)];
  if (ids.length !== 1 || authors.length !== 1 || scopes.length !== 1) return;
  const eventId = hex(ids[0]?.[1]);
  const author = hex(
    authors[0]?.[1]?.match(/\bhex: ([0-9a-fA-F]{64})\)$/)?.[1],
  );
  const channelText = scopes[0]?.[1] ?? "";
  const channelId = channelText.match(/\(#([^()]+)\)$/)?.[1] ?? channelText;
  if (
    !eventId ||
    !author ||
    !channel(channelId) ||
    !scope ||
    channelId !== scope
  )
    return;
  const rest = body.slice(content.index + content[0].length);
  // Tags/Parsed are producer trailers; never pull From/Content inside prose into identity.
  const trailer =
    /\r?\nTags: (\[[^\r\n]*\])(?:\r?\nParsed: [^\r\n]*)?\r?$/.exec(rest);
  if (!trailer) return;
  let tags: unknown;
  try {
    tags = JSON.parse(trailer[1] ?? "");
    if (!Array.isArray(tags)) return;
  } catch {
    return;
  }
  const text = rest.slice(0, trailer.index);
  if (/^<\/?buzz-event\b|^\[Buzz event|^--- Event \d+/m.test(text)) return;
  const kinds = [...header.matchAll(/^Kind: ([^\r\n]+)\r?$/gm)];
  const reportedAudience = messageAudience(
    kinds.length === 1 && /^(9|45001|45003)$/.test(kinds[0]?.[1] ?? "")
      ? Number(kinds[0]?.[1])
      : undefined,
    tags,
  );
  return {
    direction: "incoming",
    body: text,
    author,
    eventId,
    channelId,
    ...(reportedAudience ? { reportedAudience } : {}),
  };
}

/** A reported send operation, not a delivery acknowledgment or response boundary. */
export function outgoingActivityMessage(
  entry: TranscriptEntry,
  author: string,
  reportedId?: string,
  reportedAudience?: MessageAudience,
): ActivityMessage | undefined {
  const args = parsed(entry.input);
  const name = entry.toolName ?? entry.title;
  const direct = ["send_message", "messages_send"].includes(name);
  if (!direct && !reportedId) return;
  const bodies = direct
    ? [args?.content, args?.message, args?.text, args?.body].filter(
        (value) => value !== undefined,
      )
    : [];
  const body =
    bodies.length &&
    bodies.every((value) => typeof value === "string" && value === bodies[0])
      ? String(bodies[0])
      : "";
  const destinations = [args?.channel_id, args?.channelId].filter(
    (value) => value !== undefined,
  );
  const channelId =
    direct && destinations.length
      ? destinations.every(
          (value) => channel(value) && value === destinations[0],
        )
        ? String(destinations[0])
        : undefined
      : undefined;
  // A shell receipt does not report destination. Its observed channel is not
  // evidence that a cross-channel command sent there; keep the destination absent.
  const receipt = direct ? parsed(entry.output) : undefined;
  const eventId =
    reportedId ??
    (entry.status === "completed" &&
    receipt?.accepted === true &&
    receipt.isError !== true
      ? hex(typeof receipt.event_id === "string" ? receipt.event_id : undefined)
      : undefined);
  const audience = direct ? receipt?.audience : reportedAudience;
  return {
    direction: "outgoing",
    body: body ?? "",
    author,
    ...(channelId && { channelId }),
    ...(eventId && { eventId }),
    ...(eventId && isMessageAudience(audience)
      ? { reportedAudience: audience }
      : {}),
  };
}
