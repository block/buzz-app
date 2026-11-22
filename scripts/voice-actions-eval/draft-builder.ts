// A stand-in for drone01's `buildActionDecision`
// (`src/features/search/voice-actions.ts`), in the shape agreed for it: the
// same question keys, state JSON and resolved result. The eval runs against
// this until that module lands, then imports the real one instead. Keep it
// a faithful copy of the agreed shape, not a better design: the eval measures
// what the app will send.
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
} from "../../src/features/decisions/service";
import {
  placeOptions,
  type JumpPlace,
} from "../../src/features/search/voice-jump";
import { heardAs } from "../../src/features/search/heard-as";
import { soundsLike } from "../../src/features/search/sounds-like";

/** VOICE_EVAL_HEARD_AS=0 hints entities with plain `soundsLike`, as before
 * `heardAs`, for an A/B. */
const entityHints =
  process.env.VOICE_EVAL_HEARD_AS === "0" ? soundsLike : heardAs;

export type SlotKind =
  | "channel"
  | "section"
  | "person"
  | "emoji"
  | "message"
  | "text";

export type Thing = Readonly<{
  kind: Exclude<SlotKind, "text">;
  key: string;
  label: string;
  detail?: string;
}>;

export type ActionDef = Readonly<{
  id: string;
  /** What owns the action. Undefined: it needs no owner (create a section). */
  owner?: Exclude<SlotKind, "text">;
  target?: SlotKind;
  /** Offered whatever is hovered, or when nothing is. */
  global?: boolean;
  /** A global action is offered only while one of these is hovered
   * (`nothing` for no hover); omitted means always. */
  whenHovered?: readonly (Thing["kind"] | "nothing")[];
  sentence: (owner: string, target: string) => string;
  confirm: "none" | "confirm";
}>;

export type Entity = Readonly<{
  key: string;
  option: string;
  kind?: string;
  detail?: string;
}>;

export type Binding = Readonly<{
  action: ActionDef;
  role: "owner" | "target" | "global";
  owner?: Thing;
  target?: Thing;
  missingSlot?: SlotKind;
  option: string;
}>;

export type ResolvedAction =
  | Readonly<{
      kind: "action";
      actionId: string;
      binding: Binding;
      probability: number;
      owner?: string;
      target?: string;
      text?: string;
    }>
  | Readonly<{ kind: "navigate"; place: string; probability: number }>
  | Readonly<{ kind: "none"; probability: number }>;

export const NAVIGATE = "Ignore hover, just navigate to a place";
export const NONE = "None of these";
const ENTITY_NONE = "none";

const NOUN: Record<SlotKind, string> = {
  channel: "a channel",
  section: "a section",
  person: "someone",
  emoji: "an emoji",
  message: "a message",
  text: "a name they say",
};

/** Every way the hovered thing fits an action: as its owner (forward), as
 * its target (reverse), both when the types match, plus global actions. */
export function bindings(
  hovered: Thing | null,
  actions: readonly ActionDef[],
): Binding[] {
  const out: Binding[] = [];
  for (const action of actions) {
    if (hovered && action.owner === hovered.kind) {
      out.push({
        action,
        role: "owner",
        owner: hovered,
        ...(action.target ? { missingSlot: action.target } : {}),
        option: action.sentence(
          hovered.label,
          action.target
            ? action.target === action.owner
              ? `another ${NOUN[action.target].replace(/^an? /, "")}`
              : NOUN[action.target]
            : "",
        ),
      });
    }
    if (hovered && action.owner && action.target === hovered.kind) {
      out.push({
        action,
        role: "target",
        target: hovered,
        missingSlot: action.owner,
        option: action.sentence(
          action.target === action.owner
            ? `another ${NOUN[action.owner].replace(/^an? /, "")}`
            : NOUN[action.owner],
          hovered.label,
        ),
      });
    }
    if (
      action.global &&
      !action.owner &&
      (!action.whenHovered ||
        action.whenHovered.includes(hovered?.kind ?? "nothing"))
    )
      out.push({
        action,
        role: "global",
        ...(action.target ? { missingSlot: action.target } : {}),
        option: action.sentence("", action.target ? NOUN[action.target] : ""),
      });
  }
  return out;
}

const PLACE_INSTRUCTIONS =
  // Copied from `pickPlace` in voice-jump.ts, which keeps it inline.
  "A person said `spoken_request` aloud to jump to a place in a workplace chat app. It is an automatic speech transcript, not typed text. Place names are often product names, jargon or people's names that speech recognition doesn't know, so it often writes a name as a common word or name that sounds like it, splits or joins its words, or spells it another way. Compare how the words sound when said aloud, not how they are spelled: a word or phrase that sounds like a place's name counts as saying that name. A place's `sounds_like` lists words in the transcript that sound like its name. Each option is a place they can go to: a channel (#name), a DM (named by the other people in it), a chat with an agent, or a thread (named by its first message and where it is). `places` gives each option's details, most recently active first. Which place did they ask to go to? A place whose name matches what they said, by sound, beats one whose messages only mention it. Pick a thread only when they asked for a thread or a specific discussion. Pick none when nothing they said sounds like or describes any place.";

const ACTION_INSTRUCTIONS =
  "A person pointed at something in a workplace chat app (`hovered`, or nothing) and said `spoken_request` aloud. It is an automatic speech transcript: names are often misheard as common words that sound like them, so compare by sound. Each option is one thing the app can do. In an option, the hovered thing is named, and words like 'a channel', 'someone', 'a section', 'an emoji' or 'another channel' stand for the part they name in what they said. 'This', 'it', 'here' and 'him/her/them' usually mean the hovered thing. Pick the option that does what they asked, including which part is the hovered thing. Pick `" +
  NAVIGATE +
  "` when they asked to go to, open or show a place, even one they are pointing at. Pick `" +
  NONE +
  "` when they asked for none of these.";

const slotInstructions = (kind: SlotKind) =>
  `A person said \`spoken_request\` aloud in a workplace chat app while pointing at \`hovered\`. It is an automatic speech transcript: names are often misheard as common words that sound like them, so compare by sound; \`sounds_like\` lists transcript words that sound like an option's name. Names are often ordinary words, such as a channel called random or a person called Wes, so a plain word that matches an option's name counts as naming it. If they named ${NOUN[kind]} other than the hovered thing, which one? Options are listed in \`${kind}\`. Pick none when they named no ${kind}.`;

/** The rule for free-text names: what's left after the action's words. */
export function spokenName(spoken: string): string | undefined {
  const rest = spoken
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(
      /^(please\s+)?(can you\s+)?(add|create|make|new|start|rename (this|it)( section)?( to)?)(\s+(me\s+)?(a|an))?(\s+new)?(\s+sidebar)?(\s+section|\s+group|\s+folder)?(\s+(called|named|for))?\s+/i,
      "",
    )
    .replace(/\s+(section|group|folder)$/i, "")
    .trim();
  if (!rest || rest.toLowerCase() === spoken.trim().toLowerCase())
    return undefined;
  return rest.replace(/\b\w/g, (c) => c.toUpperCase());
}

export type BuildInput = Readonly<{
  spoken: string;
  hovered: Thing | null;
  actions: readonly ActionDef[];
  entities: Readonly<Partial<Record<SlotKind, readonly Entity[]>>>;
  places: readonly JumpPlace[];
  community?: string;
}>;

export function buildActionDecision(input: BuildInput): {
  request: DecisionRequest | undefined;
  resolve: (
    answers: Readonly<Record<string, DecisionAnswer>>,
    threshold?: number,
  ) => ResolvedAction;
} {
  const { spoken, hovered, places } = input;
  const all = bindings(hovered, input.actions).filter(
    (b) =>
      !b.missingSlot ||
      b.missingSlot === "text" ||
      (input.entities[b.missingSlot]?.length ?? 0) > 0,
  );
  // Unique option labels, as choice keys must be.
  const taken = new Set<string>([NAVIGATE, NONE]);
  const options = all.map((b) => {
    let label = b.option;
    for (let n = 2; taken.has(label); n++) label = `${b.option} (${n})`;
    taken.add(label);
    return label;
  });
  const slots = [
    ...new Set(
      all.flatMap((b) =>
        b.missingSlot && b.missingSlot !== "text" ? [b.missingSlot] : [],
      ),
    ),
  ];
  const labels = placeOptions(places);
  const questions: Record<string, DecisionQuestion> = {};
  const state: Record<string, unknown> = {
    spoken_request: spoken,
    hovered: hovered
      ? {
          kind: hovered.kind,
          label: hovered.label,
          ...(hovered.detail ? { detail: hovered.detail } : {}),
        }
      : null,
  };
  if (all.length) {
    const actionOptions: Record<string, string> = {};
    for (const label of options) actionOptions[label] = "";
    if (places.length)
      actionOptions[NAVIGATE] =
        "They asked to go to, open or show a place rather than to act on something.";
    actionOptions[NONE] = "They asked for none of these.";
    questions.action = {
      type: "choice",
      instructions: ACTION_INSTRUCTIONS,
      options: actionOptions,
    };
    state.actions = all.map((b, i) => ({
      option: options[i],
      action_id: b.action.id,
      role: b.role,
    }));
  }
  for (const slot of slots) {
    const entities = (input.entities[slot] ?? []).slice(0, 200);
    const opts: Record<string, string> = {};
    for (const e of entities) opts[e.option] = "";
    opts[ENTITY_NONE] = `They named no ${slot}.`;
    questions[slot] = {
      type: "choice",
      instructions: slotInstructions(slot),
      options: opts,
    };
    state[slot] = entities.map((e) => {
      const heard =
        slot === "emoji" ? [] : entityHints(spoken, e.option.replace(/^#/, ""));
      return {
        option: e.option,
        ...(e.kind ? { kind: e.kind } : {}),
        ...(e.detail ? { detail: e.detail } : {}),
        ...(heard.length ? { sounds_like: heard } : {}),
      };
    });
  }
  if (places.length) {
    const opts: Record<string, string> = {};
    for (const label of labels) opts[label] = "";
    opts[ENTITY_NONE] = "None of these places is the one the person asked for.";
    questions.place = {
      type: "choice",
      instructions: PLACE_INSTRUCTIONS,
      options: opts,
    };
    state.places = places.map(
      ({ kind, name, in: where, about, recent }, index) => {
        const heard = kind === "thread" ? [] : soundsLike(spoken, name);
        return {
          option: labels[index],
          kind,
          ...(heard.length ? { sounds_like: heard } : {}),
          ...(where ? { in: where } : {}),
          ...(about ? { about } : {}),
          ...(recent ? { recent_messages: recent } : {}),
        };
      },
    );
  }
  const request: DecisionRequest | undefined = Object.keys(questions).length
    ? {
        state: JSON.stringify(state),
        questions,
        timeoutMs: 8_000,
        ...(input.community ? { community: input.community } : {}),
      }
    : undefined;

  const resolve = (
    answers: Readonly<Record<string, DecisionAnswer>>,
    threshold = 0.5,
  ): ResolvedAction => {
    const pick = (name: string) => {
      const a = answers[name];
      return a?.type === "choice"
        ? {
            choice: a.choice,
            p: a.probabilities[a.choice] ?? a.confidence,
          }
        : undefined;
    };
    const navigate = (p: number): ResolvedAction => {
      const place = pick("place");
      const index = place ? labels.indexOf(place.choice) : -1;
      return index >= 0 && place && place.p >= threshold
        ? {
            kind: "navigate",
            place: (places[index] as JumpPlace).key,
            probability: Math.min(p, place.p),
          }
        : { kind: "none", probability: p };
    };
    const action = pick("action");
    if (!action) return navigate(1);
    if (action.choice === NAVIGATE) return navigate(action.p);
    const index = options.indexOf(action.choice);
    const binding = all[index];
    if (!binding || action.p < threshold)
      return { kind: "none", probability: action.p };
    let filled: string | undefined;
    let text: string | undefined;
    let p = action.p;
    if (binding.missingSlot === "text") {
      text = spokenName(spoken);
      if (!text) return { kind: "none", probability: p };
    } else if (binding.missingSlot) {
      const slot = pick(binding.missingSlot);
      const entity = input.entities[binding.missingSlot]?.find(
        (e) => e.option === slot?.choice,
      );
      if (!slot || !entity) return { kind: "none", probability: p };
      filled = entity.key;
      p = Math.min(p, slot.p);
    }
    const owner =
      binding.owner?.key ?? (binding.role === "target" ? filled : undefined);
    const target =
      binding.target?.key ?? (binding.role !== "target" ? filled : undefined);
    return {
      kind: "action",
      actionId: binding.action.id,
      binding,
      probability: p,
      ...(owner ? { owner } : {}),
      ...(target ? { target } : {}),
      ...(text ? { text } : {}),
    };
  };
  return { request, resolve };
}
