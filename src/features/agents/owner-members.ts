// Owner member changes: add, remove and role changes in one of the owner's
// channels, through the owner's existing member services. Library agents are
// added as the agent library adds them, people as Members invites them, and
// removals and roles go through member administration; each service signs,
// re-checks rights and checks the call's admission before publishing.
import type {
  OwnerExecution,
  OwnerMemberAdd,
  OwnerMemberRemove,
  OwnerMemberResult,
  OwnerMemberRole,
} from "../../buzz-mcp/client";
import { administerMember } from "../channel-members/administration";
import type { MemberAuthority } from "../channel-members/administration-protocol";
import {
  addChannelMember,
  isBatchAddition,
  type MemberAdditionIntent,
} from "../channel-members/members";
import { channelIdentity } from "../relay/channel-labels";
import {
  channelTypeTag,
  exactLifecycleTag,
} from "../relay/channel-lifecycle-protocol";
import type { RelayEvent } from "../relay/events";
import type { OutgoingEvent } from "../relay/outbox";
import { foldProfiles } from "../relay/profiles";
import { soloLabels } from "../solo/labels";
import type { OwnerBinding } from "./owner-access";

/** One admitted change: the binding it runs on, the call's combined
 * cancellation, its synchronous admission and a fresh relay-signed read of the
 * channel, which refuses system channels and channels not the owner's. */
export type OwnerMemberContext = Readonly<{
  /** The calling agent. */
  agent: string;
  binding: OwnerBinding;
  channel: string;
  signal: AbortSignal;
  active: () => boolean;
  execution: OwnerExecution;
  authority(): Promise<
    Readonly<{ rights: MemberAuthority; metadata: RelayEvent }>
  >;
}>;

type Target = "agent" | "person" | "other-agent" | "unknown";

export async function addOwnerMember(
  context: OwnerMemberContext,
  { pubkey, role }: OwnerMemberAdd,
): Promise<OwnerMemberResult> {
  const { binding, channel, signal, active } = context;
  const { session } = binding;
  const result = outcome(context, pubkey);
  if (pubkey === binding.viewer)
    return result.rejected(
      "Owner tools cannot add your owner themselves to a channel.",
    );
  const { rights, metadata } = await context.authority();
  const refused = unchangeable(metadata);
  if (refused) return result.rejected(refused);
  const current = rights.roles[pubkey];
  if (current) return result.confirmed(current);
  const target = await classify(context, pubkey, rights);
  if (target === "other-agent")
    return result.rejected(
      "This agent is not in your owner's agent library, so it cannot be added.",
    );
  if (target === "unknown")
    return result.rejected(
      "Could not confirm whether this is a person or an agent: they have no profile, or your owner's agent library is still loading. Nothing was sent.",
    );
  if (target === "agent" && role)
    return result.rejected(
      "role applies to people. Add the agent, then change its role with owner_member_set_role.",
    );
  if (role && solo(metadata))
    return result.rejected("A Solo chat is shared without a role.");
  await session.outbox?.ready();
  const prior = addition(session.outbox?.snapshot(), channel, pubkey);
  // A pending Bot grant is an agent's addition; a person never resumes it.
  if (
    target === "person" &&
    prior?.event.tags.some(([tag, value]) => tag === "role" && value === "bot")
  )
    return result.rejected(
      "An agent addition for this key is still in your owner's Outbox; it must be removed there first.",
      target,
      prior,
    );
  const intent: MemberAdditionIntent = role ? { role } : {};
  // This call's receipts, recorded as they appear: an acknowledged one leaves
  // the snapshot, so it can't be inferred afterwards.
  const { outbox } = session;
  const before = new Set(outbox?.snapshot().map((item) => item.event.id));
  const ours = new Set(prior ? [prior.event.id] : []);
  const watch = () => {
    for (const item of outbox?.snapshot() ?? [])
      if (
        !before.has(item.event.id) &&
        item.event.kind === 9000 &&
        names(item, channel, pubkey)
      )
        ours.add(item.event.id);
  };
  const stop = outbox?.subscribe(watch);
  try {
    if (target === "agent")
      await session.channelWrites.addAgents(channel, [pubkey], active);
    else
      await addChannelMember(
        session,
        channel,
        pubkey,
        signal,
        intent,
        session.outbox,
        solo(metadata),
        active,
      );
  } catch (error) {
    watch();
    if (intent.id) ours.add(intent.id);
    stop?.();
    const reason = message(error);
    // The addition may have landed before the failure: the roster decides.
    const shown = await context
      .authority()
      .then(({ rights }) => rights.roles[pubkey])
      .catch(() => undefined);
    const operation = intent.id ?? [...ours].at(-1);
    const extra = {
      target,
      ...(operation ? { operation } : {}),
      ...(prior ? { existing: true as const } : {}),
    };
    if (shown) return result.confirmed(shown, extra);
    // A signed intent ID is not delivery evidence. Only no attempt, or receipts
    // all still proven undelivered and unacknowledged, is a refusal.
    const live = new Map(
      outbox?.snapshot().map((item) => [item.event.id, item]),
    );
    return [...ours].every((id) => {
      const receipt = live.get(id);
      return receipt?.delivery === "failed" && !receipt.acknowledged;
    })
      ? { ...result.rejected(reason), ...extra }
      : { ...result.unconfirmed(reason), ...extra };
  }
  watch();
  stop?.();
  const operation = intent.id ?? [...ours].at(-1);
  return readback(context, result, pubkey, target, operation, !!prior);
}

export async function removeOwnerMember(
  context: OwnerMemberContext,
  { pubkey, expectedRole }: OwnerMemberRemove,
): Promise<OwnerMemberResult> {
  const { binding } = context;
  const result = outcome(context, pubkey);
  if (pubkey === binding.viewer)
    return result.rejected(
      "Owner tools cannot remove your owner themselves from a channel.",
    );
  await binding.session.outbox?.ready();
  const { rights, metadata } = await context.authority();
  const refused = unchangeable(metadata);
  if (refused) return result.rejected(refused);
  const adding = () => unresolvedAddition(context, pubkey);
  if (adding())
    return result.rejected(
      "An addition of this member is still sending or unresolved; check again once it settles.",
    );
  if (!rights.roles[pubkey])
    return expectedRole
      ? result.rejected(
          "They are no longer a member.",
          undefined,
          undefined,
          null,
        )
      : result.confirmed(null);
  const active = () => context.active() && !adding();
  return administered({ ...context, active }, result, pubkey, (now) =>
    now ? { expectedRole: expectedRole ?? now, role: "remove" } : undefined,
  );
}

export async function setOwnerMemberRole(
  context: OwnerMemberContext,
  { pubkey, role, expectedRole }: OwnerMemberRole,
): Promise<OwnerMemberResult> {
  const { binding } = context;
  const result = outcome(context, pubkey);
  if (pubkey === context.agent)
    return result.rejected("You cannot change your own role.");
  if (pubkey === binding.viewer)
    return result.rejected("Owner tools cannot change your owner's own role.");
  await binding.session.outbox?.ready();
  const { rights, metadata } = await context.authority();
  const refused = unchangeable(metadata);
  if (refused) return result.rejected(refused);
  if (solo(metadata))
    return result.rejected("Roles cannot be changed in a Solo chat.");
  const adding = () => unresolvedAddition(context, pubkey);
  if (adding())
    return result.rejected(
      "An addition of this member is still sending or unresolved; check again once it settles.",
    );
  const current = rights.roles[pubkey];
  if (!current)
    return result.rejected(
      "They are not a member.",
      undefined,
      undefined,
      null,
    );
  if (current !== expectedRole)
    return result.rejected(
      `Their role is now ${current}, not ${expectedRole}.`,
      undefined,
      undefined,
      current,
    );
  if (current === role || (role === "member" && current === "bot"))
    return result.confirmed(current);
  if (role === "admin") {
    const target = await classify(context, pubkey, rights);
    if (target !== "person")
      return result.rejected(
        target === "unknown"
          ? "Only a confirmed person can be made an admin, and this one could not be confirmed as a person."
          : "Agents cannot be made admins.",
      );
  }
  const active = () => context.active() && !adding();
  return administered({ ...context, active }, result, pubkey, () => ({
    expectedRole,
    role,
  }));
}

/** A change through member administration, under this call's admission. Its
 * outcome, signed command and confirmed role come from the snapshot it leaves,
 * not its resolved promise. */
async function administered(
  context: OwnerMemberContext,
  result: ReturnType<typeof outcome>,
  pubkey: string,
  decide: Parameters<typeof administerMember>[3],
) {
  const { binding, channel, signal, active } = context;
  const admin = binding.session.memberAdministration;
  // Each run records a new change, so a different one afterwards is this call's.
  const before = admin.snapshot(channel).operation?.change;
  const done = await administerMember(
    admin,
    channel,
    pubkey,
    decide,
    undefined,
    { signal, active },
  );
  const { operation, authority } = admin.snapshot(channel);
  const ours =
    !!operation &&
    operation.change !== before &&
    operation.change.pubkey === pubkey;
  const extra = ours && operation.event ? { operation: operation.event } : {};
  if (done.status === "confirmed")
    return result.confirmed(authority.roles[pubkey] ?? null, extra);
  // An earlier change on this channel that may have taken effect fences new
  // ones; this call sent nothing.
  if (done.status === "failed" && operation?.status === "uncertain" && !ours)
    return result.rejected(
      "An earlier member change in this channel may have taken effect and is unresolved; nothing was sent. Check owner_member_list, then try again.",
    );
  const reason = done.error ?? "The change could not be confirmed.";
  // This call's own command may have been published before it failed.
  return done.status === "failed" && !(ours && operation.status === "uncertain")
    ? { ...result.rejected(reason), ...extra }
    : { ...result.unconfirmed(reason), ...extra };
}

/** The roster read after an addition: its role, or unconfirmed when the read
 * fails or doesn't show them. */
async function readback(
  context: OwnerMemberContext,
  result: ReturnType<typeof outcome>,
  pubkey: string,
  target: "agent" | "person",
  operation: string | undefined,
  existing: boolean,
) {
  const extra = {
    target,
    ...(operation ? { operation } : {}),
    ...(existing ? { existing: true as const } : {}),
  };
  try {
    const { rights } = await context.authority();
    const role = rights.roles[pubkey];
    if (role) return result.confirmed(role, extra);
  } catch (error) {
    return { ...result.unconfirmed(message(error)), ...extra };
  }
  return {
    ...result.unconfirmed("The roster read for this call does not show them."),
    ...extra,
  };
}

/** Who `pubkey` is, from the owner's current agent inventory, the roster and
 * their profile read now. Only complete evidence makes a person. */
async function classify(
  { binding, signal }: OwnerMemberContext,
  pubkey: string,
  rights: MemberAuthority,
): Promise<Target> {
  const { session } = binding;
  if (!session.agentChoices.snapshot().complete)
    await session.agentChoices.refresh();
  signal.throwIfAborted();
  const choices = session.agentChoices.snapshot();
  if (choices.identities.some((agent) => agent.pubkey === pubkey))
    return "agent";
  if (rights.roles[pubkey] === "bot") return "other-agent";
  const events = await session.readRemote(
    [{ kinds: [0], authors: [pubkey], limit: 1, consistency: "strong" }],
    { signal, priority: "foreground" },
  );
  signal.throwIfAborted();
  const profile = foldProfiles(
    events.filter((event) => event.pubkey === pubkey),
  ).get(pubkey);
  if (profile?.isAgent) return "other-agent";
  return choices.complete && profile ? "person" : "unknown";
}

/** Why members of this channel can't be changed, if they can't. */
function unchangeable(metadata: RelayEvent) {
  if (channelTypeTag(metadata) === "dm")
    return "Members of a DM cannot be changed.";
  if (exactLifecycleTag(metadata, "archived") === "true")
    return "The channel is archived.";
  return undefined;
}

const solo = (metadata: RelayEvent) =>
  channelTypeTag(metadata) === "stream" &&
  !!soloLabels(channelIdentity(metadata).labels);

/** The newest unacknowledged single addition of `pubkey` to `channel`, if
 * any. */
function addition(
  items: readonly OutgoingEvent[] | undefined,
  channel: string,
  pubkey: string,
) {
  return items
    ?.filter(
      (item) =>
        item.event.kind === 9000 &&
        !item.acknowledged &&
        !isBatchAddition(item) &&
        names(item, channel, pubkey),
    )
    .at(-1);
}

/** An unresolved invitation may still restore access after removal or a role
 * change, even when a separate invitation already put the member in the roster. */
function unresolvedAddition(context: OwnerMemberContext, pubkey: string) {
  return !!context.binding.session.outbox
    ?.snapshot()
    .some(
      (item) =>
        item.event.kind === 9000 &&
        !item.acknowledged &&
        (item.delivery === "sending" || item.delivery === "unknown") &&
        names(item, context.channel, pubkey),
    );
}

/** Whether `item` names `pubkey` in `channel`. */
const names = (item: OutgoingEvent, channel: string, pubkey: string) =>
  item.event.tags.some(([tag, value]) => tag === "h" && value === channel) &&
  item.event.tags.some(([tag, value]) => tag === "p" && value === pubkey);

function outcome(context: OwnerMemberContext, pubkey: string) {
  const base = {
    execution: context.execution,
    channel: context.channel,
    pubkey,
  };
  type Role = OwnerMemberResult["role"];
  return {
    confirmed: (role: Role, extra: Partial<OwnerMemberResult> = {}) =>
      ({ ...base, status: "confirmed", role, ...extra }) as OwnerMemberResult,
    rejected: (
      reason: string,
      target?: "agent" | "person",
      receipt?: OutgoingEvent,
      role?: Role,
    ): OwnerMemberResult => ({
      ...base,
      status: "rejected",
      reason,
      ...(target ? { target } : {}),
      ...(receipt ? { operation: receipt.event.id } : {}),
      ...(role !== undefined ? { role } : {}),
    }),
    unconfirmed: (
      reason: string,
      target?: "agent" | "person",
      receipt?: OutgoingEvent,
    ): OwnerMemberResult => ({
      ...base,
      status: "unconfirmed",
      reason,
      ...(target ? { target } : {}),
      ...(receipt ? { operation: receipt.event.id } : {}),
    }),
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
