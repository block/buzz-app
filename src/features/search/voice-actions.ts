// Pure action registry, forward/reverse lookup, and single-round-trip
// Decisions request/response builder for contextual voice actions.
// Intentionally free of React and RelaySession runtime imports so evals and
// tests can exercise the exact request shape the app sends.
import type {
  DecisionAnswer,
  DecisionFailure,
  DecisionQuestion,
  DecisionRequest,
  Decisions,
} from "../decisions/service";
import { nameWords } from "./sounds-like";
import { heardAs } from "./heard-as";
import type { VoiceSlotKind, VoiceThing } from "./voice-context";
import {
  buildPlaceQuestion,
  resolvePlaceAnswer,
  type JumpCandidate,
  type JumpPlace,
} from "./voice-jump";

export const VOICE_ACTION_THRESHOLD = 0.5;
export const VOICE_ACTION_AUTO_THRESHOLD = 0.7;
export const VOICE_ACTION_LIVE_THRESHOLD = 0.8;
/** Minimum place confidence when navigate is in top two and action misses auto-run threshold. */
export const NAVIGATE_OVERRIDE_PLACE_THRESHOLD = 0.8;
/** Step 2 also needs navigate itself to be a real contender: a confident
 * place with navigate at 0.13 is a named channel, not a wish to go there. */
export const NAVIGATE_OVERRIDE_MIN = 0.3;

export const ACTION_NAVIGATE_OPTION = "Ignore hover, just navigate to a place";
export const ACTION_NONE_OPTION = "None of these";

const SLOT_NONE = "none";
const MAX_SLOT_OPTIONS = 200;
const LABEL_LIMIT = 90;
const CANDIDATE_MIN = 0.1;
const MAX_CANDIDATES = 3;

export type ConfirmPolicy = "none" | "confirm";
export type EntitySlotKind = Exclude<VoiceSlotKind, "text">;
export type HoveredRole = "owner" | "target" | "none";

export type VoiceEntity = Readonly<{
  kind: EntitySlotKind;
  id: string;
  label: string;
  /** Short extra context shown to Jev (e.g. "Direct message", "#general"). */
  detail?: string | undefined;
  /** Name passed to `soundsLike` (defaults to `label`). */
  soundsLikeName?: string | undefined;
  /** Optional metadata for action execution or filtering. */
  meta?: Readonly<Record<string, unknown>> | undefined;
}>;

export type VoiceSlotEntities = Readonly<
  Partial<Record<EntitySlotKind, readonly VoiceEntity[]>>
>;

export type VoiceActionSpec = Readonly<{
  id: string;
  /** Subject/owner slot kind, or null for global actions needing no owner entity. */
  owner: Exclude<EntitySlotKind, "emoji"> | null;
  /** Optional object/target slot kind. */
  target?: VoiceSlotKind | undefined;
  /** "confirm" never fires on partial speech and shows a confirm chip (Enter/Esc). */
  confirm: ConfirmPolicy;
  /** For global (`owner: null`) actions, restrict which hovered kinds include it.
   * Omitting allows it when hovering anything or nothing. */
  whenHovered?: readonly VoiceThing["kind"][] | undefined;
  /** Fill the action sentence presented to Jev for a concrete hovered binding. */
  describe: (binding: {
    hoveredRole: HoveredRole;
    bound?: VoiceEntity | undefined;
  }) => string;
  /** Optional custom free-text extractor when the missing slot is `"text"`. */
  extractText?: ((spoken: string) => string | undefined) | undefined;
  /** Optional filter restricting valid slot candidates for a binding. */
  filterSlot?: (
    slot: EntitySlotKind,
    entity: VoiceEntity,
    bound?: VoiceEntity | undefined,
  ) => boolean;
}>;

export type VoiceActionBinding<Spec extends VoiceActionSpec = VoiceActionSpec> =
  Readonly<{
    action: Spec;
    hoveredRole: HoveredRole;
    bound?: VoiceEntity | undefined;
    missingSlot?: VoiceSlotKind | undefined;
    sentence: string;
  }>;

export type VoiceActionInvocation<Ctx = unknown> = Readonly<{
  ctx: Ctx;
  owner?: VoiceEntity | undefined;
  target?: VoiceEntity | undefined;
  text?: string | undefined;
  spoken: string;
}>;

export type VoiceAction<Ctx = unknown, Env = unknown> = VoiceActionSpec &
  Readonly<{
    available?: (
      ctx: Ctx,
      binding: {
        hoveredRole: HoveredRole;
        bound?: VoiceEntity | undefined;
      },
    ) => boolean;
    summary: (invocation: VoiceActionInvocation<Ctx>) => string;
    run: (
      invocation: VoiceActionInvocation<Ctx>,
      env: Env,
    ) => Promise<void> | void;
  }>;

export type ActionCandidate = Readonly<{
  kind: "action" | "navigate";
  actionId?: string | undefined;
  binding?: VoiceActionBinding | undefined;
  label: string;
  probability: number;
  /** Resolved slot values when available, so UI can execute/confirm a clicked option. */
  owner?: VoiceEntity | undefined;
  target?: VoiceEntity | undefined;
  text?: string | undefined;
}>;

export type ResolvedAction =
  | Readonly<{
      kind: "action";
      actionId: string;
      binding: VoiceActionBinding;
      probability: number;
      owner?: VoiceEntity | undefined;
      target?: VoiceEntity | undefined;
      text?: string | undefined;
      actionCandidates: readonly ActionCandidate[];
      placeCandidates: readonly JumpCandidate[];
    }>
  | Readonly<{
      kind: "navigate";
      place: JumpPlace;
      probability: number;
      actionCandidates: readonly ActionCandidate[];
      placeCandidates: readonly JumpCandidate[];
    }>
  | Readonly<{
      kind: "none";
      actionCandidates: readonly ActionCandidate[];
      placeCandidates: readonly JumpCandidate[];
    }>;

export type VoiceActionDecisionOutcome =
  | ResolvedAction
  | Readonly<{ kind: "failed"; reason: DecisionFailure }>;

export function thingToEntity(
  thing: VoiceThing | null | undefined,
): VoiceEntity | undefined {
  if (!thing || thing.kind === "nothing") return undefined;
  switch (thing.kind) {
    case "message":
      return {
        kind: "message",
        id: thing.id,
        label: thing.label,
        ...(thing.preview ? { detail: thing.preview } : {}),
        ...(thing.authorName ? { soundsLikeName: thing.authorName } : {}),
        meta: {
          channelId: thing.channelId,
          ...(thing.threadRootId ? { threadRootId: thing.threadRootId } : {}),
          ...(thing.authorId ? { authorId: thing.authorId } : {}),
          ...(thing.authorName ? { authorName: thing.authorName } : {}),
          ...(thing.preview ? { preview: thing.preview } : {}),
        },
      };
    case "channel":
      return {
        kind: "channel",
        id: thing.id,
        label: thing.label,
        ...(thing.channelType ? { detail: thing.channelType } : {}),
        soundsLikeName: thing.name,
        meta: {
          name: thing.name,
          ...(thing.channelType ? { channelType: thing.channelType } : {}),
          ...(thing.sectionKey ? { sectionKey: thing.sectionKey } : {}),
          ...(thing.starred !== undefined ? { starred: thing.starred } : {}),
          ...(thing.peerPubkey ? { peerPubkey: thing.peerPubkey } : {}),
        },
      };
    case "section":
      return {
        kind: "section",
        id: thing.id,
        label: thing.label,
        soundsLikeName: thing.name,
        meta: {
          name: thing.name,
          ...(thing.sectionId ? { sectionId: thing.sectionId } : {}),
        },
      };
    case "person":
      return {
        kind: "person",
        id: thing.id,
        label: thing.label,
        soundsLikeName: thing.name,
        meta: {
          name: thing.name,
          ...(thing.channelId ? { channelId: thing.channelId } : {}),
        },
      };
    case "agent":
      return {
        kind: "agent",
        id: thing.id,
        label: thing.label,
        soundsLikeName: thing.name,
        meta: { name: thing.name },
      };
    case "thread":
      return {
        kind: "thread",
        id: thing.id,
        label: thing.label,
        ...(thing.name ? { soundsLikeName: thing.name } : {}),
        meta: {
          channelId: thing.channelId,
          ...(thing.name ? { name: thing.name } : {}),
        },
      };
    case "community":
      return {
        kind: "community",
        id: thing.id,
        label: thing.label,
        soundsLikeName: thing.name,
        meta: { name: thing.name },
      };
  }
}

const LEAD_FILLER_RE =
  /^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:add|create|make|new|start|name|rename(?:\s+(?:it|this|the\s+section|section))?\s+(?:to|as)?|call(?:\s+it)?)\s+(?:(?:a|an|the)\s+)?(?:(?:new|sidebar)\s+)*(?:(?:section|group|folder|channel)(?:\s+(?:called|named))?(?:\s+|$))?/i;

/** Deterministic rule-based name extraction for free-text actions (e.g.
 * "add buzz community" -> "buzz community", "create section called Work" -> "Work"). */
export function extractFreeText(spoken: string): string | undefined {
  const cleaned = spoken
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(LEAD_FILLER_RE, "")
    .replace(/^(?:called|named)\s+/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function hasSlotCandidate(
  action: VoiceActionSpec,
  slot: VoiceSlotKind | undefined,
  entities: VoiceSlotEntities | undefined,
  bound: VoiceEntity | undefined,
): boolean {
  if (!slot || slot === "text" || !entities) return true;
  const list = entities[slot];
  if (!list?.length) return false;
  const filter = action.filterSlot;
  if (!filter) return true;
  return list.some((item) => filter(slot, item, bound));
}

/** Matches actions by forward lookup (hovered === owner), reverse lookup
 * (hovered === target), and global actions (owner === null). Same-type
 * actions produce both owner and target bindings as separate candidates. */
export function matchActionBindings<Spec extends VoiceActionSpec>(
  actions: readonly Spec[],
  hovered: VoiceThing | null | undefined,
  entities?: VoiceSlotEntities | undefined,
  isAvailable?: (
    action: Spec,
    binding: { hoveredRole: HoveredRole; bound?: VoiceEntity | undefined },
  ) => boolean,
): VoiceActionBinding<Spec>[] {
  const entity = thingToEntity(hovered);
  const hoveredKind = hovered?.kind ?? "nothing";
  const bindings: VoiceActionBinding<Spec>[] = [];

  for (const action of actions) {
    if (action.owner === null) {
      if (action.whenHovered && !action.whenHovered.includes(hoveredKind)) {
        continue;
      }
      const role = { hoveredRole: "none" as const };
      if (
        hasSlotCandidate(action, action.target, entities, undefined) &&
        (!isAvailable || isAvailable(action, role))
      ) {
        bindings.push({
          action,
          hoveredRole: "none",
          ...(action.target ? { missingSlot: action.target } : {}),
          sentence: action.describe(role),
        });
      }
      continue;
    }

    if (!entity) continue;

    // Forward lookup: hovered thing is the owner/subject.
    if (action.owner === entity.kind) {
      const role = { hoveredRole: "owner" as const, bound: entity };
      if (
        hasSlotCandidate(action, action.target, entities, entity) &&
        (!isAvailable || isAvailable(action, role))
      ) {
        bindings.push({
          action,
          hoveredRole: "owner",
          bound: entity,
          ...(action.target ? { missingSlot: action.target } : {}),
          sentence: action.describe(role),
        });
      }
    }

    // Reverse lookup: hovered thing is the target/object.
    if (action.target === entity.kind) {
      const role = { hoveredRole: "target" as const, bound: entity };
      if (
        hasSlotCandidate(action, action.owner, entities, entity) &&
        (!isAvailable || isAvailable(action, role))
      ) {
        bindings.push({
          action,
          hoveredRole: "target",
          bound: entity,
          missingSlot: action.owner,
          sentence: action.describe(role),
        });
      }
    }
  }

  return bindings;
}

function deduplicateLabels(
  items: readonly string[],
  reserved: readonly string[],
): string[] {
  const taken = new Set<string>(reserved);
  return items.map((raw) => {
    const base =
      raw.length > LABEL_LIMIT ? `${raw.slice(0, LABEL_LIMIT - 1)}…` : raw;
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} (${n})`;
    taken.add(label);
    return label;
  });
}

const ORDINARY_WORDS_HINT =
  "Names are often ordinary words, such as a channel called random or a person called Wes, so a plain word that matches an option's name counts as naming it.";

const SLOT_INSTRUCTIONS: Record<EntitySlotKind, string> = {
  channel: `Which channel did the person name or sound like in \`spoken_request\`? Compare how words sound aloud using \`sounds_like\`. ${ORDINARY_WORDS_HINT} Pick none if no channel was named.`,
  section: `Which sidebar section did the person name or sound like in \`spoken_request\`? Compare how words sound aloud using \`sounds_like\`. ${ORDINARY_WORDS_HINT} Pick none if no section was named.`,
  person: `Which person or agent did the person name or sound like in \`spoken_request\`? Compare how words sound aloud using \`sounds_like\`. ${ORDINARY_WORDS_HINT} Pick none if no person or agent was named.`,
  agent: `Which agent did the person name or sound like in \`spoken_request\`? Compare how words sound aloud using \`sounds_like\`. ${ORDINARY_WORDS_HINT} Pick none if no agent was named.`,
  emoji:
    "Which emoji reaction did the person ask for in `spoken_request`? Pick none if none matches.",
  thread:
    "Which thread did the person name or describe in `spoken_request`? Pick none if none matches.",
  community: `Which community did the person name or sound like in \`spoken_request\`? ${ORDINARY_WORDS_HINT} Pick none if none matches.`,
  message:
    "Which message did the person refer to in `spoken_request`? Pick none if none matches.",
};

export type ActionDecisionInput = Readonly<{
  spoken: string;
  hovered: VoiceThing | null;
  actions: readonly VoiceActionSpec[];
  entities: VoiceSlotEntities;
  places: readonly JumpPlace[];
  community?: string | undefined;
  /** Pre-filtered bindings (e.g. with runtime `available` checks applied). */
  bindings?: readonly VoiceActionBinding[] | undefined;
}>;

export type BuiltActionDecision = Readonly<{
  request: DecisionRequest | undefined;
  resolve: (
    answers: Readonly<Record<string, DecisionAnswer>> | undefined,
    threshold?: number,
  ) => ResolvedAction;
}>;

/** Builds a single-round-trip Decisions request containing `action` (with
 * navigate & none), speculative slot find questions, and jump's `place`
 * question, plus a deterministic `resolve(answers)` mapper. */
export function buildActionDecision(
  input: ActionDecisionInput,
): BuiltActionDecision {
  const { spoken, hovered, actions, entities, places, community } = input;
  const emptyResult: ResolvedAction = {
    kind: "none",
    actionCandidates: [],
    placeCandidates: [],
  };

  if (!spoken.trim()) {
    return { request: undefined, resolve: () => emptyResult };
  }

  const bindings =
    input.bindings ?? matchActionBindings(actions, hovered, entities);

  if (bindings.length === 0 && places.length === 0) {
    return { request: undefined, resolve: () => emptyResult };
  }

  const placeBuilt =
    places.length > 0 ? buildPlaceQuestion(spoken, places) : undefined;

  // No contextual or global actions matched: behave identically to VoiceJump.
  if (bindings.length === 0 && placeBuilt) {
    return {
      request: {
        state: JSON.stringify({
          spoken_request: spoken,
          places: placeBuilt.statePlaces,
        }),
        questions: { place: placeBuilt.question },
        timeoutMs: 8_000,
        ...(community ? { community } : {}),
      },
      resolve: (answers, threshold = VOICE_ACTION_THRESHOLD) => {
        const resolved = resolvePlaceAnswer(
          answers?.place,
          places,
          placeBuilt.labels,
          threshold,
        );
        if (resolved.outcome === "found") {
          return {
            kind: "navigate",
            place: resolved.place,
            probability: resolved.probability,
            actionCandidates: [],
            placeCandidates: resolved.candidates,
          };
        }
        return {
          kind: "none",
          actionCandidates: [],
          placeCandidates: resolved.candidates,
        };
      },
    };
  }

  const reservedActionLabels = placeBuilt
    ? [ACTION_NAVIGATE_OPTION, ACTION_NONE_OPTION]
    : [ACTION_NONE_OPTION];
  const actionLabels = deduplicateLabels(
    bindings.map((b) => b.sentence),
    reservedActionLabels,
  );

  const actionOptions: Record<string, string> = {};
  for (const label of actionLabels) actionOptions[label] = "";
  if (placeBuilt) {
    actionOptions[ACTION_NAVIGATE_OPTION] =
      "The person wants to jump/navigate to a channel, DM, chat, or thread instead of acting on the hovered item. Not when they asked to move, arrange or change something: that is an action, or none of these if no option does it.";
  }
  actionOptions[ACTION_NONE_OPTION] =
    "None of these actions or navigation applies to what the person said.";

  // Collect open entity slots needed by any candidate binding.
  const openSlots = new Set<EntitySlotKind>();
  for (const binding of bindings) {
    if (binding.missingSlot && binding.missingSlot !== "text") {
      openSlots.add(binding.missingSlot);
    }
  }

  const slotEntries = new Map<
    EntitySlotKind,
    { entities: readonly VoiceEntity[]; labels: string[] }
  >();
  const slotStateTables: Record<string, Record<string, unknown>[]> = {};
  const questions: Record<string, DecisionQuestion> = {
    action: {
      type: "choice",
      instructions:
        "A person hovered an item in a chat app (described in `hovered`) and spoke `spoken_request` aloud. It is an automatic speech transcript, so names may be misspelled phonetically and 'star' may be written as 'start'. Pick the single action they asked to run, or pick 'Ignore hover, just navigate to a place' if they are trying to jump somewhere instead of acting on the hovered item, or 'None of these' if nothing matches.",
      options: actionOptions,
    },
  };

  for (const slot of openSlots) {
    const list = (entities[slot] ?? []).slice(0, MAX_SLOT_OPTIONS);
    if (!list.length) continue;
    const labels = deduplicateLabels(
      list.map((item) => item.label),
      [SLOT_NONE],
    );
    slotEntries.set(slot, { entities: list, labels });
    const options: Record<string, string> = {};
    for (const label of labels) options[label] = "";
    options[SLOT_NONE] = `None of these ${slot}s matches what was said.`;
    questions[slot] = {
      type: "choice",
      instructions: SLOT_INSTRUCTIONS[slot],
      options,
    };
    slotStateTables[slot] = list.map((item, idx) => {
      const heard = heardAs(spoken, item.soundsLikeName ?? item.label);
      return {
        option: labels[idx],
        ...(item.detail ? { detail: item.detail } : {}),
        ...(heard.length ? { sounds_like: heard } : {}),
      };
    });
  }

  if (placeBuilt) {
    questions.place = placeBuilt.question;
  }

  const statePayload: Record<string, unknown> = {
    spoken_request: spoken,
    hovered:
      hovered && hovered.kind !== "nothing"
        ? {
            kind: hovered.kind,
            label: hovered.label,
          }
        : null,
    actions: bindings.map((binding, idx) => ({
      option: actionLabels[idx],
      action_id: binding.action.id,
      role: binding.hoveredRole,
    })),
    ...(placeBuilt ? { places: placeBuilt.statePlaces } : {}),
    ...slotStateTables,
  };

  const request: DecisionRequest = {
    state: JSON.stringify(statePayload),
    questions,
    timeoutMs: 8_000,
    ...(community ? { community } : {}),
  };

  const resolve = (
    answers: Readonly<Record<string, DecisionAnswer>> | undefined,
    threshold = VOICE_ACTION_THRESHOLD,
  ): ResolvedAction => {
    const placeResolved = placeBuilt
      ? resolvePlaceAnswer(answers?.place, places, placeBuilt.labels, threshold)
      : { outcome: "none" as const, candidates: [] };
    const placeCandidates = placeResolved.candidates;

    const resolveBindingSlots = (
      binding: VoiceActionBinding,
    ):
      | {
          ok: true;
          owner?: VoiceEntity | undefined;
          target?: VoiceEntity | undefined;
          text?: string | undefined;
          slotProb?: number | undefined;
        }
      | { ok: false } => {
      let owner = binding.hoveredRole === "owner" ? binding.bound : undefined;
      let target = binding.hoveredRole === "target" ? binding.bound : undefined;
      let text: string | undefined;
      let slotProb: number | undefined;

      if (binding.missingSlot === "text") {
        text = binding.action.extractText
          ? binding.action.extractText(spoken)
          : extractFreeText(spoken);
        if (!text) return { ok: false };
      } else if (binding.missingSlot) {
        const slotData = slotEntries.get(binding.missingSlot);
        const slotAnswer = answers?.[binding.missingSlot];
        if (!slotData || slotAnswer?.type !== "choice") {
          return { ok: false };
        }

        const pickEntity = ():
          | { entity: VoiceEntity; prob: number }
          | undefined => {
          const directIdx =
            slotAnswer.choice === SLOT_NONE
              ? -1
              : slotData.labels.indexOf(slotAnswer.choice);
          const directEntity =
            directIdx >= 0 ? slotData.entities[directIdx] : undefined;
          const directProb =
            slotAnswer.probabilities[slotAnswer.choice] ??
            slotAnswer.confidence ??
            0;
          if (
            directEntity &&
            directProb >= threshold &&
            // The hovered thing fills the other slot, never this one too.
            directEntity.id !== binding.bound?.id &&
            (!binding.action.filterSlot ||
              binding.action.filterSlot(
                binding.missingSlot as EntitySlotKind,
                directEntity,
                binding.bound,
              ))
          ) {
            return { entity: directEntity, prob: directProb };
          }
          // If direct choice failed filterSlot, look for highest-prob valid option above threshold.
          if (binding.action.filterSlot) {
            let best: { entity: VoiceEntity; prob: number } | undefined;
            for (let i = 0; i < slotData.labels.length; i++) {
              const candidate = slotData.entities[i];
              const label = slotData.labels[i];
              if (!candidate || !label || candidate.id === binding.bound?.id)
                continue;
              const p = slotAnswer.probabilities[label] ?? 0;
              if (
                p >= threshold &&
                candidate.id !== binding.bound?.id &&
                binding.action.filterSlot(
                  binding.missingSlot as EntitySlotKind,
                  candidate,
                  binding.bound,
                ) &&
                (!best || p > best.prob)
              ) {
                best = { entity: candidate, prob: p };
              }
            }
            return best;
          }
          return undefined;
        };

        const fallbackFromPlace = ():
          | { entity: VoiceEntity; prob: number }
          | undefined => {
          // Stands in for an empty find, so it clears the same bar as
          // step 2: a silent action never gets in through a weaker place.
          if (
            placeResolved.outcome !== "found" ||
            placeResolved.probability <
              Math.max(threshold, NAVIGATE_OVERRIDE_PLACE_THRESHOLD)
          ) {
            return undefined;
          }
          const matchedPlace = placeResolved.place;
          let candidate: VoiceEntity | undefined;
          if (
            binding.missingSlot === "channel" &&
            matchedPlace.kind === "channel"
          ) {
            candidate = slotData.entities.find(
              (item) =>
                item.id === matchedPlace.channelId &&
                item.id !== binding.bound?.id,
            );
          } else if (
            binding.missingSlot === "person" &&
            matchedPlace.kind === "dm"
          ) {
            const matches = slotData.entities.filter(
              (item) =>
                item.label === matchedPlace.name &&
                item.id !== binding.bound?.id,
            );
            if (matches.length === 1) candidate = matches[0];
          } else if (
            binding.missingSlot === "thread" &&
            matchedPlace.kind === "thread" &&
            matchedPlace.rootId
          ) {
            candidate = slotData.entities.find(
              (item) =>
                item.id === matchedPlace.rootId &&
                item.id !== binding.bound?.id,
            );
          }
          if (
            candidate &&
            (!binding.action.filterSlot ||
              binding.action.filterSlot(
                binding.missingSlot as EntitySlotKind,
                candidate,
                binding.bound,
              ))
          ) {
            return { entity: candidate, prob: placeResolved.probability };
          }
          return undefined;
        };

        const picked = pickEntity() ?? fallbackFromPlace();
        if (!picked) return { ok: false };
        slotProb = picked.prob;
        if (binding.hoveredRole === "target") {
          owner = picked.entity;
        } else {
          target = picked.entity;
        }
      }

      return { ok: true, owner, target, text, slotProb };
    };

    const actionAnswer = answers?.action;
    if (actionAnswer?.type !== "choice") {
      return { kind: "none", actionCandidates: [], placeCandidates };
    }

    const actionCandidates: ActionCandidate[] = [
      ...actionLabels.flatMap((label, idx) => {
        const candidateBinding = bindings[idx];
        if (!candidateBinding) return [];
        const slots = resolveBindingSlots(candidateBinding);
        return [
          {
            kind: "action" as const,
            actionId: candidateBinding.action.id,
            binding: candidateBinding,
            label,
            probability: actionAnswer.probabilities[label] ?? 0,
            ...(slots.ok && slots.owner ? { owner: slots.owner } : {}),
            ...(slots.ok && slots.target ? { target: slots.target } : {}),
            ...(slots.ok && slots.text !== undefined
              ? { text: slots.text }
              : {}),
          },
        ];
      }),
      ...(placeBuilt
        ? [
            {
              kind: "navigate" as const,
              label: ACTION_NAVIGATE_OPTION,
              probability:
                actionAnswer.probabilities[ACTION_NAVIGATE_OPTION] ?? 0,
            },
          ]
        : []),
    ]
      .filter(({ probability }) => probability >= CANDIDATE_MIN)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, MAX_CANDIDATES);

    if (actionAnswer.choice === ACTION_NONE_OPTION) {
      return { kind: "none", actionCandidates, placeCandidates };
    }

    const actionProb =
      actionAnswer.probabilities[actionAnswer.choice] ??
      actionAnswer.confidence ??
      0;

    // Single 3-step decision rule:
    // 1. Act if the top choice is >= 0.7 (or >= 0.5 when confirm-gated) and
    //    isn't navigating to the thing a top-two action would act on.
    // 2. Otherwise, navigate if navigate is in the top two, the place is >= 0.8,
    //    and it isn't the thing the rival action would act on.
    // 3. Otherwise, show the options.
    const rivalAction = actionCandidates
      .slice(0, 2)
      .find((candidate) => candidate.kind === "action");
    const placeIsActionObject =
      placeResolved.outcome === "found" &&
      [rivalAction?.owner, rivalAction?.target].some(
        (entity) =>
          !!entity &&
          entity.id ===
            (placeResolved.place.kind === "thread"
              ? placeResolved.place.rootId
              : placeResolved.place.channelId),
      );
    const navigateInTopTwo = actionCandidates
      .slice(0, 2)
      .some((candidate) => candidate.kind === "navigate");
    const autoThreshold = Math.max(threshold, VOICE_ACTION_AUTO_THRESHOLD);

    const tryNavigate = (): ResolvedAction | undefined => {
      if (placeResolved.outcome !== "found" || placeIsActionObject) {
        return undefined;
      }
      const step1 =
        actionAnswer.choice === ACTION_NAVIGATE_OPTION &&
        actionProb >= autoThreshold &&
        placeResolved.probability >= threshold;
      const step2 =
        navigateInTopTwo &&
        (actionAnswer.probabilities[ACTION_NAVIGATE_OPTION] ?? 0) >=
          NAVIGATE_OVERRIDE_MIN &&
        placeResolved.probability >=
          Math.max(threshold, NAVIGATE_OVERRIDE_PLACE_THRESHOLD);
      if (!step1 && !step2) return undefined;
      return {
        kind: "navigate",
        place: placeResolved.place,
        probability: placeResolved.probability,
        actionCandidates,
        placeCandidates,
      };
    };

    if (actionAnswer.choice === ACTION_NAVIGATE_OPTION) {
      return (
        tryNavigate() ?? {
          kind: "none",
          actionCandidates,
          placeCandidates,
        }
      );
    }

    const bindingIdx = actionLabels.indexOf(actionAnswer.choice);
    const binding = bindingIdx >= 0 ? bindings[bindingIdx] : undefined;

    if (!binding) {
      return (
        tryNavigate() ?? {
          kind: "none",
          actionCandidates,
          placeCandidates,
        }
      );
    }

    const requiredActionProb =
      binding.action.confirm === "none" ? autoThreshold : threshold;

    if (actionProb < requiredActionProb) {
      return (
        tryNavigate() ?? {
          kind: "none",
          actionCandidates,
          placeCandidates,
        }
      );
    }

    const slots = resolveBindingSlots(binding);
    if (!slots.ok) {
      return (
        tryNavigate() ?? {
          kind: "none",
          actionCandidates,
          placeCandidates,
        }
      );
    }

    return {
      kind: "action",
      actionId: binding.action.id,
      binding,
      probability: Math.min(actionProb, slots.slotProb ?? actionProb),
      ...(slots.owner ? { owner: slots.owner } : {}),
      ...(slots.target ? { target: slots.target } : {}),
      ...(slots.text !== undefined ? { text: slots.text } : {}),
      actionCandidates,
      placeCandidates,
    };
  };

  return { request, resolve };
}

export async function decideVoiceAction(
  decisions: Decisions,
  input: ActionDecisionInput,
  threshold = VOICE_ACTION_THRESHOLD,
): Promise<VoiceActionDecisionOutcome> {
  const built = buildActionDecision(input);
  if (!built.request) {
    return { kind: "none", actionCandidates: [], placeCandidates: [] };
  }
  const result = await decisions.decide(built.request);
  if (result.outcome !== "answered") {
    return { kind: "failed", reason: result.reason };
  }
  return built.resolve(result.answers, threshold);
}

const wordsOf = (name: string) =>
  new Set(nameWords(name).map((word) => word.toLowerCase()));

/** True if another entity in `pool` shares all words of `entity`'s name and
 * has more words, so a speaker mid-phrase may still be saying the longer name. */
export function extendableEntity(
  entity: VoiceEntity,
  pool: readonly VoiceEntity[],
): boolean {
  const own = wordsOf(entity.soundsLikeName ?? entity.label);
  if (!own.size) return false;
  return pool.some((other) => {
    if (other.id === entity.id) return false;
    const theirs = wordsOf(other.soundsLikeName ?? other.label);
    return theirs.size > own.size && [...own].every((word) => theirs.has(word));
  });
}

export type LiveActionLead = Readonly<{ key: string; words: number }>;

/** Live-speech hold check for `confirm: "none"` actions: fires immediately at
 * >= 0.8 unless a slot entity has a longer extendable name in `entities`, in
 * which case it waits for one more word on the same winner. */
export function holdsActionLead(
  lead: LiveActionLead | undefined,
  outcome: VoiceActionDecisionOutcome,
  said: string,
  entities: VoiceSlotEntities,
): { fire: boolean; lead: LiveActionLead | undefined } {
  if (
    outcome.kind !== "action" ||
    outcome.binding.action.confirm !== "none" ||
    outcome.probability < VOICE_ACTION_LIVE_THRESHOLD
  ) {
    return { fire: false, lead: undefined };
  }
  const resolvedSlot =
    outcome.binding.hoveredRole === "target" ? outcome.owner : outcome.target;
  const slotKey = `${outcome.actionId}:${resolvedSlot?.id ?? ""}`;
  const pool = resolvedSlot ? (entities[resolvedSlot.kind] ?? []) : [];
  if (!resolvedSlot || !extendableEntity(resolvedSlot, pool)) {
    return { fire: true, lead };
  }
  const words = said.trim().split(/\s+/).length;
  if (lead?.key !== slotKey) {
    return { fire: false, lead: { key: slotKey, words } };
  }
  return { fire: words > lead.words, lead };
}
