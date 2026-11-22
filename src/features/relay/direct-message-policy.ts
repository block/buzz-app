/** Participant-set policy shared by the app and the existing browser broker.
 * An addition is bounded only for size: the relay counts its people. */
export function validDirectMessageParticipants(
  pubkeys: readonly string[],
  viewer: string,
  adding = false,
): boolean {
  return (
    pubkeys.length >= 1 &&
    pubkeys.length <= (adding ? MAX_DIRECT_MESSAGE_ADDITIONS : 8) &&
    new Set(pubkeys).size === pubkeys.length &&
    pubkeys.every((key) => /^[0-9a-f]{64}$/.test(key) && key !== viewer)
  );
}

/** The most people and agents one addition to a DM names. */
export const MAX_DIRECT_MESSAGE_ADDITIONS = 100;

/** The relay's refusal of an addition tagged `["history", "ask"]`: people
 * would join this DM, so the adder chooses whether they see its history. */
export const NEEDS_HISTORY_CHOICE = "needs-choice: history";

/** An agent's add policy refused it a DM: only its owner may add it
 * (`owner_only`), or no one may (`nobody`). */
export type AgentPolicyRefusal = Readonly<{
  policy: "owner_only" | "nobody";
  agent: string;
}>;

/** The relay names the agent whose add policy refused a DM open or add,
 * after its policy code; the hosts pass on only this form. */
const AGENT_POLICY_REFUSAL =
  /^(?:forbidden: )?policy:(owner_only|nobody)\b.*\(agent ([0-9a-f]{64})\)$/;

/** The agent and policy of an agent's add-policy refusal, from the relay's
 * reason or the form the hosts pass on. */
export function agentPolicyRefusal(
  reason: unknown,
): AgentPolicyRefusal | undefined {
  const [, policy, agent] =
    (typeof reason === "string" && AGENT_POLICY_REFUSAL.exec(reason)) || [];
  return policy && agent
    ? { policy: policy as AgentPolicyRefusal["policy"], agent }
    : undefined;
}

/** What to show for an agent's add-policy refusal, naming the agent, and
 * its verified owner when known, so the person knows whom to ask. `agent`
 * and `owner` are identity labels, which tell namesakes apart. */
export function agentPolicyMessage(
  adding: boolean,
  { policy }: AgentPolicyRefusal,
  agent: string | undefined,
  owner?: string,
): string {
  const refused =
    policy === "nobody"
      ? `${agent ?? "This agent"} can’t be added to a DM.`
      : owner
        ? `Only ${owner} can add ${agent ?? "this agent"} to a DM.`
        : `Only the owner of ${agent ?? "this agent"} can add it to a DM.`;
  return `${adding ? "Couldn’t add them. " : ""}${refused}`;
}

/** What to show for the relay's refusal of a DM command, from its exact
 * reason. A relay from before `ask` refuses the tag itself, which asks too.
 * An agent's add-policy refusal passes on as
 * `policy:<policy> (agent <pubkey>)`, for the app to name the agent. */
export function directMessageRefusal(adding: boolean, reason: unknown): string {
  const full = `${adding ? "Couldn’t add them. " : ""}A DM holds up to 9 people, not counting agents.`;
  if (
    adding &&
    (reason === NEEDS_HISTORY_CHOICE ||
      reason === 'invalid: history must be "include", got "ask"')
  )
    return NEEDS_HISTORY_CHOICE;
  const agent = agentPolicyRefusal(reason);
  if (agent) return `policy:${agent.policy} (agent ${agent.agent})`;
  // The browser host maps a refusal at admission and again on its way out.
  if (
    reason === full ||
    (typeof reason === "string" && reason.includes("at most 9 people"))
  )
    return full;
  return adding
    ? "Couldn’t add them. Try again."
    : "Could not open the direct message. Try again.";
}

/** The longest conversation name, in characters, as the relay counts it. */
export const MAX_CONVERSATION_NAME_LENGTH = 255;
/** The longest conversation description, as a channel's `about`. */
export const MAX_CONVERSATION_ABOUT_LENGTH = 1000;
/** The longest picture URL the relay stores, in bytes. */
export const MAX_CONVERSATION_PICTURE_LENGTH = 2048;

/** A conversation name as the relay canonicalizes it: leading `#` and
 * whitespace and trailing whitespace dropped. Empty when nothing is left. */
export const conversationName = (name: string) =>
  name.replace(/^[#\s]+/u, "").trimEnd();

/** Whether `value` is a picture the relay stores: an http(s) URL with no
 * whitespace or control characters. Empty means no picture. */
export const validConversationPicture = (value: string) =>
  value === "" ||
  (new TextEncoder().encode(value).length <= MAX_CONVERSATION_PICTURE_LENGTH &&
    /^https?:\/\//.test(value) &&
    !/[\s\p{Cc}]/u.test(value));

/** What naming a DM sends, once checked: the canonical name and the optional
 * picture and about. Throws the words to show for anything the relay would
 * refuse. */
export function conversationNameDetails(input: {
  name: string;
  picture?: string | undefined;
  about?: string | undefined;
}) {
  const name = conversationName(input.name);
  if (!name) throw new Error("Give this conversation a name.");
  if (Array.from(name).length > MAX_CONVERSATION_NAME_LENGTH)
    throw new Error("That name is too long.");
  if (input.picture !== undefined && !validConversationPicture(input.picture))
    throw new Error("The picture must be a web address.");
  if (
    input.about !== undefined &&
    Array.from(input.about).length > MAX_CONVERSATION_ABOUT_LENGTH
  )
    throw new Error("That description is too long.");
  return {
    name,
    ...(input.picture ? { picture: input.picture } : {}),
    ...(input.about !== undefined ? { about: input.about } : {}),
  };
}

/** The kinds of the commands that name a DM and move its history. */
export const NAME_DM_KIND = 41013;
export const MOVE_DM_HISTORY_KIND = 41014;

const NAME_REFUSALS = {
  people: "Only people can do that. Agents can’t.",
  full: "A conversation holds up to 9 people, not counting agents.",
  nameRequired: "Give this conversation a name.",
  nameLong: "That name is too long.",
  generic: "Couldn’t name this conversation. Try again.",
};
const MOVE_REFUSALS = {
  exists: "A conversation with these people already exists.",
  nothing: "Add someone, or give the new conversation a name.",
  reply: "Start from a message that isn’t a reply.",
  large: "That’s too much history to move. Start from a later message.",
  changed: "This conversation changed while moving. Try again.",
  nameRequired: "Give the new conversation a name.",
  generic: "Couldn’t move this history. Try again.",
};
const SHOWN = new Set([
  ...Object.values(NAME_REFUSALS),
  ...Object.values(MOVE_REFUSALS),
]);

/** What to show for the relay's refusal of naming a DM (41013) or moving its
 * history (41014), from its exact reason. Anything unrecognized gets the
 * command's generic words: a refusal never reaches the app verbatim. The
 * browser host maps a refusal at admission and again on its way out, so words
 * already chosen here map to themselves. */
export function directMessageCommandRefusal(
  kind: number,
  reason: unknown,
): string {
  const text = typeof reason === "string" ? reason : "";
  if (SHOWN.has(text)) return text;
  if (/only a person|only people|agents cannot/.test(text))
    return NAME_REFUSALS.people;
  if (/at most 9 people/.test(text)) return NAME_REFUSALS.full;
  if (kind === NAME_DM_KIND) {
    if (/name is required/.test(text)) return NAME_REFUSALS.nameRequired;
    if (/name is longer/.test(text)) return NAME_REFUSALS.nameLong;
    return NAME_REFUSALS.generic;
  }
  if (/already exists/.test(text)) return MOVE_REFUSALS.exists;
  if (/add people or a name/.test(text)) return MOVE_REFUSALS.nothing;
  if (/not a top-level message/.test(text)) return MOVE_REFUSALS.reply;
  if (/too much history/.test(text)) return MOVE_REFUSALS.large;
  if (/changed during the move/.test(text)) return MOVE_REFUSALS.changed;
  if (/name is required/.test(text)) return MOVE_REFUSALS.nameRequired;
  if (/name is longer/.test(text)) return NAME_REFUSALS.nameLong;
  return MOVE_REFUSALS.generic;
}

/** Whether a DM of `members` is the DM of `expected`, as the relay decides:
 * by its people when it has two or more, so agents never change which DM it
 * is; otherwise by every member. */
export function sameDirectMessage(
  members: readonly string[],
  expected: ReadonlySet<string>,
  isAgent: (pubkey: string) => boolean,
): boolean {
  const people = [...expected].filter((key) => !isAgent(key));
  const shared =
    people.length >= 2 ? members.filter((key) => !isAgent(key)) : [...members];
  const required = people.length >= 2 ? new Set(people) : expected;
  return (
    shared.length === required.size && shared.every((key) => required.has(key))
  );
}
