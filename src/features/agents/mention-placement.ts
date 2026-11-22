// Where an owner's top-level mention is answered, as a plugin decides it when
// the message arrives: at the top level, or in the thread of a message. The
// runner asks before it hands the mention to the harness, which then keys the
// turn's conversation, prompt and tool defaults to that place, as it does for
// a plugin wake's `root` or `topLevel`.
import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import type { AgentKey } from "./membership";

/** A thread on another message (its 64-hex id), or the channel's top level. */
export type MentionPlacement = Readonly<{ root: string } | { topLevel: true }>;
/** A placer's answer: the place, and private text for the turn, such as
 * "the message asks for the answer in another channel". Either can be left
 * out: a note alone keeps the native place. */
export type MentionPlacerAnswer = Readonly<{
  root?: string;
  topLevel?: true;
  note?: string;
}>;
/** What the runner gets: a checked place and note, each optional. */
export type PlacedMention = Readonly<{
  placement?: MentionPlacement;
  note?: string;
}>;
/** Notes longer than this are cut. */
export const PLACEMENT_NOTE_LIMIT = 2000;
export type MentionPlacer = Readonly<{
  id: string;
  /** Asked once per top-level mention of a local agent. Undefined, a throw
   * or no answer within PLACEMENT_TIMEOUT_MS keeps the native place: a
   * thread on the message. */
  place(
    input: Readonly<{ agent: AgentKey; channel: string; event: RelayEvent }>,
    signal: AbortSignal,
  ): Promise<MentionPlacerAnswer | undefined>;
}>;

export const PLACEMENT_TIMEOUT_MS = 3000;

/** The answer's place and note; a malformed place is dropped, and a thread
 * on the message itself is where it goes anyway. */
const checked = (value: unknown, event: RelayEvent): PlacedMention => {
  if (!value || typeof value !== "object") return {};
  const { root, topLevel, note } = value as {
    root?: unknown;
    topLevel?: unknown;
    note?: unknown;
  };
  const placement =
    topLevel === true && root === undefined
      ? ({ topLevel: true } as const)
      : topLevel === undefined &&
          typeof root === "string" &&
          /^[0-9a-f]{64}$/i.test(root) &&
          root.toLowerCase() !== event.id
        ? { root: root.toLowerCase() }
        : undefined;
  const text =
    typeof note === "string" && note.trim()
      ? note.trim().slice(0, PLACEMENT_NOTE_LIMIT)
      : undefined;
  return {
    ...(placement ? { placement } : {}),
    ...(text ? { note: text } : {}),
  };
};

export function createMentionPlacements(root: Context) {
  const placers = createContributions<MentionPlacer>(root);
  return {
    register(ctx: Context, placer: MentionPlacer) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(placer.id))
        throw new Error("A mention placer needs an id");
      if (typeof placer.place !== "function")
        throw new Error("A mention placer needs place");
      return placers.register(ctx, placer);
    },
    /** The one active placer's answer, checked; empty keeps the native
     * place. A mention inside a thread always stays in that thread. */
    async place(
      agent: AgentKey,
      channel: string,
      event: RelayEvent,
      signal: AbortSignal,
    ): Promise<PlacedMention> {
      if (threadReference(event)) return {};
      const active = placers.snapshot();
      const placer = active[0];
      // Two plugins would race for the same reply; neither decides.
      if (!placer || active.length !== 1) return {};
      const late = new AbortController();
      const timer = setTimeout(() => late.abort(), PLACEMENT_TIMEOUT_MS);
      const asked = AbortSignal.any([signal, late.signal]);
      try {
        const answer = await Promise.race([
          placer.place({ agent, channel, event }, asked),
          new Promise<undefined>((resolve) =>
            asked.addEventListener("abort", () => resolve(undefined), {
              once: true,
            }),
          ),
        ]);
        signal.throwIfAborted();
        if (asked.aborted)
          console.warn("A mention placer did not answer in time");
        return checked(answer, event);
      } catch (error) {
        signal.throwIfAborted();
        console.warn("A mention placer failed", error);
        return {};
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The mention as a harness routes it when placed in another message's
 * thread: its own id, author and text, in that thread. Local only, never
 * published, like a wake's anchor. */
export const placedAnchor = (event: RelayEvent, root: string): RelayEvent => ({
  ...event,
  tags: [
    ...event.tags.filter(([name]) => name !== "e"),
    ["e", root, "", "reply"],
  ],
});
