// Voice jump: what someone says picks one place to go among the channels,
// DMs, agent chats and threads this device already holds in memory. Nothing
// is read from the relay; the decision provider (Jev) chooses among them.
import type {
  DecisionFailure,
  Decisions,
} from "../../features/decisions/service";
import type {
  ChannelSummary,
  ChannelWindow,
} from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import { messagePreviewText } from "../../features/conversation/message-preview-text";
import { nameWords, soundsLike } from "./sounds-like";

/** Goes to the likeliest place at or above this probability. */
export const VOICE_JUMP_THRESHOLD = 0.5;
/** While words are still arriving, goes only at or above this, and, when a
 * longer name could still be being said, only once the same place stays on
 * top through another word. Measured on Jev:
 * "Take me to buzz" puts 0.49 on the wrong #buzz-* channel, and "Take me to
 * buzz sec" puts 0.96 on #buzz-security. A sure answer can still be early:
 * "the conversation about the jev" is sure of #jev before "clock" lands. */
export const VOICE_JUMP_LIVE_THRESHOLD = 0.8;
/** The most places Jev chooses among (a choice allows 255 options). */
const MAX_PLACES = 200;
/** Places, most recent first, that also carry their messages. */
const DETAILED_PLACES = 40;
/** Threads, most recent first. */
const MAX_THREADS = 40;
const RECENT_MESSAGES = 3;
const TEXT_LIMIT = 160;
const NONE = "none";

export type JumpKind = "channel" | "dm" | "chat" | "thread";

export type JumpPlace = Readonly<{
  key: string;
  kind: JumpKind;
  channelId: string;
  /** A thread's root message. */
  rootId?: string;
  name: string;
  /** Where a thread is: its conversation's name. */
  in?: string;
  about?: string;
  first?: string;
  recent?: readonly string[];
  at: number;
}>;

export type JumpSources = Readonly<{
  channels: readonly ChannelSummary[];
  /** A conversation's display name: a DM's is its other people. */
  name: (channel: ChannelSummary) => string;
  /** The messages this device holds for a conversation; never reads. */
  window: (channelId: string) => ChannelWindow;
  /** Activity rows, for threads not otherwise in memory. */
  activity: readonly InboxItem[];
  author: (pubkey: string, channel: ChannelSummary) => string;
}>;

const clip = (text: string) => {
  const line = messagePreviewText(text).replace(/\s+/g, " ").trim();
  return line.length > TEXT_LIMIT ? `${line.slice(0, TEXT_LIMIT - 1)}…` : line;
};

const kindOf = (channel: ChannelSummary): JumpKind | undefined =>
  channel.channelType === "dm"
    ? "dm"
    : channel.channelType === "solo"
      ? "chat"
      : channel.channelType === "system"
        ? undefined
        : "channel";

/** Every place a spoken request may name, most recently active first. */
export function jumpPlaces(sources: JumpSources): JumpPlace[] {
  const conversations: JumpPlace[] = [];
  const threads = new Map<string, JumpPlace>();
  const byId = new Map<string, ChannelSummary>();
  for (const channel of sources.channels) {
    const kind = kindOf(channel);
    // Every DM is `hidden` (kept out of channel directories), so only a
    // hidden non-DM is skipped.
    if (
      !kind ||
      channel.archived ||
      channel.huddle ||
      (channel.hidden && kind !== "dm")
    )
      continue;
    byId.set(channel.id, channel);
    const name = sources.name(channel);
    const history = sources.window(channel.id);
    const rows = history.rows.filter(
      (row) => row.content.trim() && !row.membership,
    );
    const said = (row: (typeof rows)[number]) =>
      `${sources.author(row.workflowOwnerId ?? row.authorId, channel)}: ${clip(row.content)}`;
    const top = rows.filter((row) => !row.threadRootId);
    const last = rows.at(-1)?.createdAt ?? 0;
    const at = Math.max(channel.lastActivityAt ?? 0, last);
    const recent = top.slice(-RECENT_MESSAGES).map(said);
    const first = !history.hasMore && top[0] ? said(top[0]) : undefined;
    conversations.push({
      key: `${kind}:${channel.id}`,
      kind,
      channelId: channel.id,
      name,
      ...(channel.description?.trim()
        ? { about: clip(channel.description) }
        : {}),
      ...(first && !recent.includes(first) ? { first } : {}),
      ...(recent.length
        ? { recent }
        : channel.preview?.trim()
          ? { recent: [clip(channel.preview)] }
          : {}),
      at,
    });
    for (const row of top) {
      if (!row.replyCount) continue;
      threads.set(row.id, {
        key: `thread:${row.id}`,
        kind: "thread",
        channelId: channel.id,
        rootId: row.id,
        name: said(row),
        in: name,
        at: row.createdAt,
      });
    }
  }
  for (const item of sources.activity) {
    const channel = byId.get(item.channelId);
    if (!item.thread || !item.rootId || !channel || threads.has(item.rootId))
      continue;
    threads.set(item.rootId, {
      key: `thread:${item.rootId}`,
      kind: "thread",
      channelId: item.channelId,
      rootId: item.rootId,
      name: item.preview.trim()
        ? `Latest reply, ${sources.author(item.workflowOwnerId ?? item.authorId, channel)}: ${clip(item.preview)}`
        : "A thread",
      in: sources.name(channel),
      at: item.createdAt,
    });
  }
  const recentFirst = (a: JumpPlace, b: JumpPlace) => b.at - a.at;
  conversations.sort(recentFirst);
  const detailed = conversations.map((place, index) =>
    index < DETAILED_PLACES
      ? place
      : {
          key: place.key,
          kind: place.kind,
          channelId: place.channelId,
          name: place.name,
          at: place.at,
        },
  );
  const recentThreads = [...threads.values()]
    .sort(recentFirst)
    .slice(0, MAX_THREADS);
  return [...detailed, ...recentThreads].slice(0, MAX_PLACES);
}

/** A place Jev gave a real share of its probability, with its option label. */
export type JumpCandidate = Readonly<{
  place: JumpPlace;
  label: string;
  probability: number;
}>;

/** Candidates shown below this share are noise. */
const CANDIDATE_MIN = 0.1;
const MAX_CANDIDATES = 3;

export type VoiceJump =
  | Readonly<{
      outcome: "found";
      place: JumpPlace;
      probability: number;
      /** The likeliest places, most likely first; the found one leads. */
      candidates: readonly JumpCandidate[];
    }>
  /** No place is likely enough. */
  | Readonly<{ outcome: "none"; candidates: readonly JumpCandidate[] }>
  | Readonly<{ outcome: "failed"; reason: DecisionFailure }>;

const LABEL_LIMIT = 90;
const KIND_LABEL: Record<JumpKind, string> = {
  channel: "#",
  dm: "DM with ",
  chat: "Chat with ",
  thread: "",
};

/** Each place's answer option: its own readable name, so Jev matches what
 * was said against names directly. Pointer keys such as `p12` pointing into
 * `places` spread Jev's probability thin once there are dozens of places. */
export function placeOptions(places: readonly JumpPlace[]): string[] {
  const taken = new Set<string>([NONE]);
  return places.map((place) => {
    const base =
      place.kind === "thread"
        ? `Thread in ${place.in ?? "a conversation"}: ${place.name}`
        : `${KIND_LABEL[place.kind]}${place.name}`;
    const clipped =
      base.length > LABEL_LIMIT ? `${base.slice(0, LABEL_LIMIT - 1)}…` : base;
    let label = clipped;
    for (let n = 2; taken.has(label); n++) label = `${clipped} (${n})`;
    taken.add(label);
    return label;
  });
}

/** The place the spoken request asked for, when one is likely enough. */
export async function pickPlace(
  decisions: Decisions,
  spoken: string,
  places: readonly JumpPlace[],
  community: string | undefined,
  threshold = VOICE_JUMP_THRESHOLD,
): Promise<VoiceJump> {
  if (!spoken.trim() || !places.length)
    return { outcome: "none", candidates: [] };
  const labels = placeOptions(places);
  const options: Record<string, string> = {};
  for (const label of labels) options[label] = "";
  options[NONE] = "None of these places is the one the person asked for.";
  const result = await decisions.decide({
    state: JSON.stringify({
      spoken_request: spoken,
      places: places.map(
        ({ kind, name, in: where, about, first, recent }, index) => {
          // A thread's name is its message; only real names are heard.
          const heard = kind === "thread" ? [] : soundsLike(spoken, name);
          return {
            option: labels[index],
            kind,
            ...(heard.length ? { sounds_like: heard } : {}),
            ...(where ? { in: where } : {}),
            ...(about ? { about } : {}),
            ...(first ? { first_message: first } : {}),
            ...(recent ? { recent_messages: recent } : {}),
          };
        },
      ),
    }),
    questions: {
      place: {
        type: "choice",
        instructions:
          "A person said `spoken_request` aloud to jump to a place in a workplace chat app. It is an automatic speech transcript, not typed text. Place names are often product names, jargon or people's names that speech recognition doesn't know, so it often writes a name as a common word or name that sounds like it, splits or joins its words, or spells it another way. Compare how the words sound when said aloud, not how they are spelled: a word or phrase that sounds like a place's name counts as saying that name. A place's `sounds_like` lists words in the transcript that sound like its name. Each option is a place they can go to: a channel (#name), a DM (named by the other people in it), a chat with an agent, or a thread (named by its first message and where it is). `places` gives each option's details, most recently active first. Which place did they ask to go to? A place whose name matches what they said, by sound, beats one whose messages only mention it. Pick a thread only when they asked for a thread or a specific discussion. Pick none when nothing they said sounds like or describes any place.",
        options,
      },
    },
    timeoutMs: 8_000,
    ...(community ? { community } : {}),
  });
  if (result.outcome !== "answered")
    return { outcome: "failed", reason: result.reason };
  const answer = result.answers.place;
  if (answer?.type !== "choice") return { outcome: "none", candidates: [] };
  const candidates = labels
    .map((label, index) => ({
      place: places[index] as JumpPlace,
      label,
      probability: answer.probabilities[label] ?? 0,
    }))
    .filter(({ probability }) => probability >= CANDIDATE_MIN)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_CANDIDATES);
  if (answer.choice === NONE) return { outcome: "none", candidates };
  const probability =
    answer.probabilities[answer.choice] ?? answer.confidence ?? 0;
  const place = places[labels.indexOf(answer.choice)];
  if (!place || probability < threshold) return { outcome: "none", candidates };
  return { outcome: "found", place, probability, candidates };
}

export type LiveLead = Readonly<{ key: string; words: number }>;

const wordsOf = (name: string) =>
  new Set(nameWords(name).map((word) => word.toLowerCase()));

/** Whether another place's name holds every word of this one's and more,
 * so a speaker who has said this name may still be saying that one: #jev
 * before "Jev clock", #buzz before #buzz-security. */
export function extendable(
  place: JumpPlace,
  places: readonly JumpPlace[],
): boolean {
  if (place.kind === "thread") return false;
  const own = wordsOf(place.name);
  if (!own.size) return false;
  return places.some((other) => {
    if (other.key === place.key || other.kind === "thread") return false;
    const theirs = wordsOf(other.name);
    return theirs.size > own.size && [...own].every((word) => theirs.has(word));
  });
}

/** While words are still landing, whether to jump on this check: at once
 * when Jev is sure, unless a longer name could still be being said; then
 * only once the same place stays sure through another word. */
export function holdsLead(
  lead: LiveLead | undefined,
  result: VoiceJump,
  said: string,
  places: readonly JumpPlace[],
): { jump: boolean; lead: LiveLead | undefined } {
  if (
    result.outcome !== "found" ||
    result.probability < VOICE_JUMP_LIVE_THRESHOLD
  )
    return { jump: false, lead: undefined };
  if (!extendable(result.place, places)) return { jump: true, lead };
  const words = said.trim().split(/\s+/).length;
  if (lead?.key !== result.place.key)
    return { jump: false, lead: { key: result.place.key, words } };
  return { jump: words > lead.words, lead };
}
