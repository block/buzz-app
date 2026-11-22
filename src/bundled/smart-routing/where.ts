// Who answers a message and where the answer goes, as Jev questions and the
// rule that combines the answers. Pure: no host, no relay. The where
// questions and thresholds are the best version from the thread-vs-top eval
// ("split-moved3"): explicit asks, the kind of place, and whether the
// message points back to an earlier one the conversation has moved past.
import type {
  DecisionAnswer,
  DecisionQuestion,
} from "../../features/decisions/service";

/** Over these, a yes counts. `moved` is stricter: it rests on few cases. */
export const WHERE_THRESHOLDS = Object.freeze({
  elsewhere: 0.5,
  top: 0.5,
  thread: 0.5,
  working: 0.5,
  moved: 0.9,
});
export type Thresholds = typeof WHERE_THRESHOLDS;
export const WHERE_KEYS = [
  "ask_elsewhere",
  "ask_top",
  "ask_thread",
  "place",
  "moved_on",
  "target",
] as const;
/** Wake the top agent only when its yes is above this. */
export const WHO_THRESHOLD = 0.5;

export type Destination =
  | Readonly<{ type: "top" }>
  | Readonly<{ type: "thread" }>
  | Readonly<{ type: "earlier"; label: string; id: string; snippet: string }>;
export type Where = Readonly<{
  destination: Destination;
  why: string;
  /** The message seems to ask for another channel or a thread it names. */
  elsewhere: boolean;
  answers: Readonly<{
    ask_elsewhere: number;
    ask_top: number;
    ask_thread: number;
    moved_on: number;
    working: number;
    target: string;
  }>;
}>;

export type ContextMessage = Readonly<{
  id: string;
  from: string;
  ms: number;
  text: string;
  replies?: readonly Readonly<{ from: string; ms: number; text: string }>[];
}>;

export function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** At most `max` characters, keeping the start and the end of a longer text:
 * offers and questions sit at the end of replies. */
export function ends(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${flat.slice(0, head).trimEnd()}…${flat.slice(flat.length - tail).trimStart()}`;
}
function ago(ms: number) {
  const secs = Math.max(0, ms / 1000);
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return `${Math.round(secs / 360) / 10}h ago`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The state every question judges: the channel, its recent top-level
 * messages (labelled m1…, oldest first, with their latest thread replies)
 * and the new message. `labels` maps each label to its message. */
export function buildState(input: {
  owner: string;
  channelName: string;
  about: string | undefined;
  humans: number;
  agents: number;
  atMs: number;
  earlier: readonly ContextMessage[];
  from: string;
  /** The owner's agents it tags; empty for an untagged message. */
  tagging: readonly string[];
  /** Set for a reply in a thread, which only asks who. */
  inThread?: boolean;
  text: string;
}) {
  const labels = new Map<string, ContextMessage>();
  const recent = input.earlier.map((item, index) => {
    const label = `m${index + 1}`;
    labels.set(label, item);
    const replies = (item.replies ?? []).slice(-4);
    return {
      id: label,
      from: item.from,
      sent: ago(input.atMs - item.ms),
      text: ends(item.text, 500),
      ...(replies.length
        ? {
            thread_replies: replies.map((reply) => ({
              from: reply.from,
              sent: ago(input.atMs - reply.ms),
              text: ends(reply.text, 300),
            })),
          }
        : {}),
    };
  });
  const state = {
    owner: `${input.owner}, who sent the new message. His AI agents are in this channel.`,
    conversation: {
      name: `#${input.channelName}`,
      type: "a channel",
      about: input.about?.trim() ? oneLine(input.about, 300) : "(none)",
      members: `${plural(input.humans, "human")} and ${plural(input.agents, "agent")}`,
    },
    recent_messages: recent,
    new_message: {
      from: input.from,
      where: input.inThread ? "a reply in a thread" : "at the top level",
      ...(input.tagging.length ? { tags: input.tagging } : {}),
      text: ends(input.text, 2000),
    },
  };
  return { state: JSON.stringify(state, null, 1), labels, recent };
}

const yesNo = (
  instructions: string,
  yes: string,
  no: string,
): DecisionQuestion => ({
  type: "yes_no",
  instructions: `${instructions}\nYes means: ${yes}\nNo means: ${no}`,
});
const WORKING =
  "A working conversation: a solo chat, a DM, or a channel where a small group works on one thing together in one running conversation (for example a few people swarming on a feature branch, a pod on one project, or a war room for one launch or incident). Messages follow on from each other.";
const SHARED =
  "A shared space: a channel many people read where unrelated topics interleave (for example an announce, general, team, discipline, platform or support channel), even when only a few people are in it right now. Posts are separate requests, questions or announcements.";

/** The where questions, keyed as WHERE_KEYS. With no earlier message there
 * is no `target`: a choice needs two options. */
export function whereQuestions(
  recent: readonly Readonly<{ id: string; from: string; text: string }>[],
): Record<string, DecisionQuestion> {
  const target: Record<string, string> = {
    new: "The new message itself: it starts its own topic, or continues the latest messages.",
  };
  for (const item of recent)
    target[item.id] =
      `An earlier message, ${item.id} from ${item.from}: "${ends(item.text, 120)}"`;
  return {
    ask_elsewhere: yesNo(
      'Does `new_message` explicitly ask for the reply to be posted in a different channel (such as "#something"), or in a specific earlier thread it names (such as "reply in Jin\'s thread")?',
      "It names another channel or a specific earlier thread to post in.",
      "It does not say where to post, or only asks for top level vs a thread here.",
    ),
    ask_top: yesNo(
      'Does `new_message` explicitly ask for the answer to be posted at the top level of this conversation, not in a thread (for example "post this top-level", "no need to thread", "start a new top-level thread")?',
      "It explicitly asks for a top-level post here.",
      "It doesn't say, or asks for something else.",
    ),
    ask_thread: yesNo(
      'Does `new_message` explicitly ask for the answer to go in a thread (for example "reply in a thread", "start a thread for this")?',
      "It explicitly asks for a thread.",
      "It doesn't say, or asks for something else.",
    ),
    place: {
      type: "choice",
      instructions:
        "What kind of place is `conversation`? Judge from its type, name, about and `recent_messages`. The number of members is a clue, not a cutoff.",
      options: { working: WORKING, shared: SHARED },
    },
    moved_on: yesNo(
      'Does `new_message` point back to one specific earlier message in `recent_messages` (for example "your checklist from this morning", "Scout\'s note", "the list from earlier"), when the conversation has moved on to other topics since that message?',
      "It points back to one specific older message, and other topics came after it.",
      "It continues the latest messages, asks a general question, or starts something new.",
    ),
    ...(recent.length
      ? {
          target: {
            type: "choice",
            instructions:
              "Suppose the reply goes in a thread. Which message's thread does `new_message` belong on?",
            options: target,
          },
        }
      : {}),
  };
}

/** The per-agent who question: is the owner talking to this agent? */
export function speakingTo(owner: string, agent: string): DecisionQuestion {
  return {
    type: "yes_no",
    instructions: `The owner, ${owner}, sent the new message without tagging anyone. Is he speaking to ${agent}, expecting ${agent} to reply or act? Yes when he addresses ${agent} directly (an instruction, question or greeting for ${agent}, by name or as "you"), or continues his back-and-forth with ${agent}. No when ${agent} is only mentioned: praising, describing or referring to ${agent} while talking to other people or to no one in particular is talking about ${agent}, not to ${agent}. Also no when the message is for someone else or needs no answer.`,
  };
}

/** The answers combined by the rule, for a top-level message in a channel:
 * an explicit ask for a thread or the top level wins; a working
 * conversation posts at the top level, or in the thread of the earlier
 * message it points back to; a shared space threads on the message. An ask
 * for another place is flagged, and the place stays. Undefined when an
 * answer is missing. */
export function decideWhere(
  answers: Readonly<Record<string, DecisionAnswer>>,
  labels: ReadonlyMap<string, ContextMessage>,
  t: Thresholds = WHERE_THRESHOLDS,
): Where | undefined {
  const yes = (key: string) => {
    const answer = answers[key];
    return answer?.type === "yes_no" ? answer.probability : undefined;
  };
  const p = {
    ask_elsewhere: yes("ask_elsewhere"),
    ask_top: yes("ask_top"),
    ask_thread: yes("ask_thread"),
    moved_on: yes("moved_on"),
  };
  const place = answers.place;
  const target = answers.target ?? {
    type: "choice",
    choice: "new",
    confidence: 1,
    probabilities: {},
  };
  if (
    p.ask_elsewhere === undefined ||
    p.ask_top === undefined ||
    p.ask_thread === undefined ||
    p.moved_on === undefined ||
    place?.type !== "choice" ||
    target.type !== "choice"
  )
    return undefined;
  const working =
    place.probabilities.working ??
    (place.choice === "working" ? place.confidence : 1 - place.confidence);
  const summary = {
    ask_elsewhere: p.ask_elsewhere,
    ask_top: p.ask_top,
    ask_thread: p.ask_thread,
    moved_on: p.moved_on,
    working,
    target: target.choice,
  };
  const elsewhere = summary.ask_elsewhere > t.elsewhere;
  const result = (destination: Destination, why: string): Where => ({
    destination,
    why,
    elsewhere,
    answers: summary,
  });
  if (p.ask_thread > t.thread)
    return result({ type: "thread" }, "asks for a thread");
  if (p.ask_top > t.top)
    return result({ type: "top" }, "asks for the top level");
  if (working <= t.working) return result({ type: "thread" }, "shared space");
  const earlier =
    target.choice === "new" ? undefined : labels.get(target.choice);
  return p.moved_on > t.moved && earlier
    ? result(
        {
          type: "earlier",
          label: target.choice,
          id: earlier.id,
          snippet: oneLine(earlier.text, 40),
        },
        "working conversation, follows up on an earlier message",
      )
    : result({ type: "top" }, "working conversation");
}

/** Where a wake or a placed mention goes for a destination. */
export function placementOf(
  destination: Destination,
  eventId: string,
): Readonly<{ topLevel: true } | { root: string }> {
  if (destination.type === "top") return { topLevel: true };
  return { root: destination.type === "earlier" ? destination.id : eventId };
}

/** The mark's words for a destination. */
export function placeText(destination: Destination) {
  if (destination.type === "top") return "top level";
  if (destination.type === "earlier")
    return `thread on "${oneLine(destination.snippet, 28)}"`;
  return "thread";
}

export const ELSEWHERE_NOTE =
  "Smart routing: the message may ask for the answer in another place (another channel or a thread it names). If it does, post there as it asks, and leave at most a short pointer here.";

/** What a woken agent is told about the place its reply goes. */
export function wherePrompt(where: Where, eventId: string) {
  const d = where.destination;
  const said =
    d.type === "top"
      ? "Smart routing placed your reply at the top level of this channel: a send without reply posts there."
      : d.type === "earlier"
        ? `Smart routing placed your reply in the thread on earlier message ${d.id} ("${d.snippet}"), which message ${eventId} follows up on: a send without reply posts there.`
        : `Smart routing placed your reply in a thread on message ${eventId}: a send without reply posts there.`;
  return where.elsewhere ? `${said}\n${ELSEWHERE_NOTE}` : said;
}
