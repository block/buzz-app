// The token use of an agent's Pi conversations, as pi-ai records it on each
// of their answers, read from the agent's Pi durable storage through the host.
// Pi owns the entries; nothing here writes or keeps them.
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import type { Pi } from "./pi";
import type { PiEntry } from "./transcript";

type Json = Record<string, unknown>;
/** A Buzz conversation's Pi conversation, as `places` lists it. */
type Place = Readonly<{
  conversation: number;
  channelId: string;
  root?: string;
  at: number;
}>;

/** pi-ai's counts, named as Buzz names them. */
const TOKENS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
] as const;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((part) => str(object(part)?.text))
        .join("\n");

/** What was asked, from the conversation's first prompt. */
function title(entries: readonly PiEntry[]) {
  const first = entries.find((entry) => entry.kind === "pi.user")?.model?.[0];
  return promptSections(text(first?.content))
    .find((section) => section.tag === "buzz-event")
    ?.body.match(/^Content: (.*)$/m)?.[1]
    ?.trim();
}

/** A conversation's model requests, its entries oldest first. pi-ai counts a
 * request's input without its cached part, and prices the models it knows. */
export function conversationUsage(
  entries: readonly PiEntry[],
  place: Omit<Place, "at">,
): Omit<SessionUsage, "revision"> | undefined {
  const observations: UsageObservation[] = [];
  const times: number[] = [];
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      if (typeof message.timestamp === "number") times.push(message.timestamp);
      const usage = object(message.usage);
      if (message.role !== "assistant" || !usage) continue;
      const cost = count(object(usage.cost)?.total);
      observations.push({
        ...(message.responseId ? { requestId: message.responseId } : {}),
        at: message.timestamp ?? 0,
        model: message.model || "pi",
        tokens: Object.fromEntries(
          TOKENS.flatMap((key) => {
            const value = count(usage[key]);
            return value === undefined ? [] : [[key, value]];
          }),
        ),
        // pi-ai prices a model it has no rates for at 0: that is unknown.
        ...(cost ? { cost: { usd: cost, source: "pi" } } : {}),
      });
    }
  if (!times.length) return undefined;
  const asked = title(entries);
  return {
    id: String(place.conversation),
    channelId: place.channelId,
    ...(place.root ? { root: place.root } : {}),
    ...(asked ? { title: asked } : {}),
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    gaps: [],
    observations,
  };
}

/** All of a conversation's entries, oldest first. */
async function entries(
  pi: Pick<Pi, "request">,
  agent: string,
  conversation: number,
  signal: AbortSignal,
) {
  const found: PiEntry[] = [];
  let cursor: unknown;
  do {
    const page = await pi.request<{ entries: PiEntry[]; next?: unknown }>(
      "entries",
      { agent, conversation, ...(cursor ? { cursor } : {}) },
    );
    signal.throwIfAborted();
    found.push(...page.entries);
    cursor = page.next;
  } while (cursor);
  return found.reverse();
}

/** The agent's Buzz conversations used since `since`. A conversation's
 * requests follow the newest message it was shown. */
export async function readUsage(
  pi: Pick<Pi, "request">,
  agent: string,
  places: readonly Place[],
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const found: SessionUsage[] = [];
  for (const place of places) {
    if (place.at < since) continue;
    const session = conversationUsage(
      await entries(pi, agent, place.conversation, signal),
      place,
    );
    if (session && session.lastAt >= since)
      found.push(await withRevision(session));
  }
  return found.sort((a, b) => b.lastAt - a.lastAt);
}
