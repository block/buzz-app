// Owner channel writes: create, update, archive, unarchive and delete through
// the owner's own session services. Each service checks admission before signing
// and publishing. Once a command may have been published, the answer is
// unconfirmed, never "nothing happened".
import type {
  OwnerChannelCreate,
  OwnerChannelUpdate,
  OwnerChannelWrite,
  OwnerExecution,
  OwnerLifecycleAction,
  OwnerMutationCaller,
} from "../../buzz-mcp/client";
import { memberAuthority } from "../channel-members/administration-protocol";
import { ChannelDetailsUnconfirmed } from "../relay/channel-details";
import {
  canonicalDetailsName,
  detailsSettings,
} from "../relay/channel-details-protocol";
import { channelIdentity } from "../relay/channel-labels";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import {
  channelTypeTag,
  lifecycleRecord,
} from "../relay/channel-lifecycle-protocol";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { SOLO_LABEL } from "../solo/labels";
import type { OwnerBinding, OwnerSession } from "./owner-access";

type Admitted = Readonly<{
  binding: OwnerBinding;
  active: () => boolean;
  signal: AbortSignal;
  execution: OwnerExecution;
}>;
type Answer = Omit<OwnerChannelWrite, "execution" | "action" | "channel">;
type Intent = Readonly<{
  name: string;
  visibility: "open" | "private";
  about: string;
  ttl: number | undefined;
  solo: boolean;
}>;

export function ownerChannelWrites({
  agent,
  admit,
  records,
  known,
}: Readonly<{
  /** The calling agent. */
  agent: string;
  admit(caller: OwnerMutationCaller | undefined): Admitted;
  /** The channel's relay-signed metadata, admin list and roster, read fresh. */
  records(
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ): Promise<readonly RelayEvent[]>;
  /** Throws unless the owner's session lists channel `id`. */
  known(session: OwnerSession, id: string): unknown;
}>) {
  const answer = (
    admitted: Admitted,
    action: OwnerChannelWrite["action"],
    channel: string,
    fields: Answer,
  ): OwnerChannelWrite => ({
    execution: admitted.execution,
    action,
    channel,
    ...fields,
  });
  /** Pre-publication refusals: nothing was sent. */
  const refused = (admitted: Admitted, error: unknown): Answer => ({
    outcome: "rejected",
    reason:
      error instanceof PublishRejected
        ? "refused"
        : !admitted.active() ||
            (error instanceof Error && error.name === "AbortError")
          ? "cancelled"
          : "failed",
    error: message(error),
  });
  /** The owner's role, the caller's membership and the metadata version, as
   * the relay records them now. */
  const readback = async (
    { binding, signal }: Admitted,
    id: string,
    events?: readonly RelayEvent[],
  ) => {
    const { relayAuthor } = binding.session;
    if (!relayAuthor) throw new Error("The owner's relay is unavailable.");
    const read = events ?? (await records(binding, id, signal));
    const rights = memberAuthority(read, id, binding.viewer, relayAuthor);
    const metadata = lifecycleRecord(read, 39000, id, relayAuthor);
    return {
      ownerRole: rights.roles[binding.viewer] ?? null,
      callerMember: agent in rights.roles,
      ...(metadata ? { version: metadata.id } : {}),
    };
  };
  /** Channel `id`, one of the owner's ordinary channels or Solo chats: never
   * a system channel or DM. */
  const target = async (admitted: Admitted, id: string) => {
    const { binding, signal } = admitted;
    known(binding.session, id);
    const events = await records(binding, id, signal);
    const metadata = binding.session.relayAuthor
      ? lifecycleRecord(events, 39000, id, binding.session.relayAuthor)
      : undefined;
    const type = metadata && channelTypeTag(metadata);
    if (type !== "stream" && type !== "forum")
      throw new Error(
        `Channel ${id} is not a channel or Solo chat that owner tools change.`,
      );
    return events;
  };

  async function create(
    input: OwnerChannelCreate,
    caller?: OwnerMutationCaller,
  ): Promise<OwnerChannelWrite> {
    const admitted = admit(caller);
    const { binding, active, signal } = admitted;
    const { session } = binding;
    const id = input.id;
    const done = (fields: Answer) => answer(admitted, "create", id, fields);
    const wanted: Intent = {
      name: canonicalDetailsName(input.name),
      visibility: input.solo ? "private" : input.visibility,
      about: input.solo ? "" : (input.description?.trim() ?? ""),
      ttl: input.ttlSeconds,
      solo: !!input.solo,
    };
    const writes = session.channelWrites;
    if (!writes.available)
      return done({
        outcome: "rejected",
        reason: "failed",
        error: "This community cannot create channels now.",
      });
    // A create this owner already queued under this ID is resumed, never
    // replaced: the same receipt, or a conflict when its intent differs.
    const journaled = () =>
      session.outbox
        ?.snapshot()
        .find(
          (item) => item.event.kind === 9007 && tag(item.event, "h") === id,
        );
    const resumed = input.operation;
    let queued = journaled();
    if (!queued) {
      const events = await records(binding, id, signal);
      if (events.some((event) => event.kind === 39000))
        return matches(binding, id, events, wanted)
          ? done({
              outcome: "confirmed",
              ...(resumed ? { operation: resumed } : {}),
              ...(await readback(admitted, id)),
            })
          : done({
              outcome: "rejected",
              reason: "conflict",
              error: `Channel ID ${id} is already in use.`,
            });
      // A concurrent call may have queued it during that read.
      queued = journaled();
      // Without its receipt or the channel, an earlier create may still be in
      // flight or applied unseen; another create could not be told from it.
      if (!queued && resumed)
        return done({
          outcome: "unconfirmed",
          operation: resumed,
          error: `Buzz no longer holds create ${resumed}, and the relay shows no channel ${id} yet, so it may still appear. Check with owner_channel_get before creating it again under a new id.`,
        });
    }
    if (queued && resumed && queued.event.id !== resumed)
      return done({
        outcome: "rejected",
        reason: "conflict",
        operation: queued.event.id,
        error: `Channel ID ${id} is queued by create ${queued.event.id}, not ${resumed}.`,
      });
    if (queued) {
      if (
        tag(queued.event, "channel_type") !== "stream" ||
        queued.event.tags.some(([key]) => key === "p") ||
        !same(intentOf(queued.event.tags), wanted)
      )
        return done({
          outcome: "rejected",
          reason: "conflict",
          operation: queued.event.id,
          error: `Channel ID ${id} is already used by a different create.`,
        });
      if (queued.delivery === "failed" && queued.refused)
        return done({
          outcome: "rejected",
          reason: "refused",
          operation: queued.event.id,
          error: queued.error ?? "The relay refused this create.",
        });
    }
    let operation: string;
    try {
      operation =
        queued?.event.id ??
        (wanted.solo
          ? writes.create(id, wanted.name, wanted.ttl, true, [], active)
          : writes.createChannel(
              id,
              wanted.name,
              wanted.visibility,
              wanted.about || undefined,
              wanted.ttl,
              active,
            ));
    } catch (error) {
      return done(refused(admitted, error));
    }
    try {
      await writes.delivered(operation, active);
      // Lists the new channel in the owner's session, as the app's create does.
      await writes.refresh(id, { member: binding.viewer }, false);
      const events = await records(binding, id, signal);
      if (!matches(binding, id, events, wanted))
        throw new Error("The created channel does not match this request.");
      await session.outbox?.dismiss(operation);
      return done({
        outcome: "confirmed",
        operation,
        ...(await readback(admitted, id, events)),
      });
    } catch (error) {
      const item = session.outbox
        ?.snapshot()
        .find((each) => each.event.id === operation);
      // Failed without the relay's answer means it never reached transport;
      // the receipt stays for a later call with this ID to resume.
      if (item?.delivery === "failed")
        return done({
          ...refused(admitted, error),
          ...(item.refused ? { reason: "refused" as const } : {}),
          operation,
          ...(item.error ? { error: item.error } : {}),
        });
      return done({ outcome: "unconfirmed", operation, error: message(error) });
    }
  }

  async function update(
    input: OwnerChannelUpdate,
    caller?: OwnerMutationCaller,
  ): Promise<OwnerChannelWrite> {
    const admitted = admit(caller);
    const { binding, signal } = admitted;
    const id = input.id;
    const done = (fields: Answer) => answer(admitted, "update", id, fields);
    const details = binding.session.channelDetails;
    await target(admitted, id);
    // An earlier unconfirmed save blocks the next until a readback settles it.
    if (details.snapshot(id)?.status === "unconfirmed")
      await details.check(id, signal).catch(() => {});
    if (details.snapshot(id))
      return done({
        outcome: "rejected",
        reason: "busy",
        error:
          "An earlier change to this channel is still saving or unconfirmed; check it in Buzz first.",
      });
    let base: Awaited<ReturnType<typeof details.load>>;
    try {
      base = await details.load(id, signal);
    } catch (error) {
      return done(refused(admitted, error));
    }
    if (base.version !== input.version)
      return done({
        outcome: "rejected",
        reason: "conflict",
        version: base.version,
        error:
          "The channel changed since that version; read it again before changing it.",
      });
    if (!base.canEdit)
      return done({
        outcome: "rejected",
        reason: "denied",
        error: "Your owner cannot edit this channel.",
      });
    const ttlSeconds =
      input.ttlSeconds === null
        ? undefined
        : (input.ttlSeconds ?? base.ttlSeconds);
    // Labels stay as they are; a renamed Solo chat keeps its chosen name.
    const draft = {
      name:
        input.name !== undefined ? canonicalDetailsName(input.name) : base.name,
      description: input.description?.trim() ?? base.description,
      visibility: input.visibility ?? base.visibility,
      ...((input.joinRole ?? base.joinRole)
        ? { joinRole: input.joinRole ?? base.joinRole }
        : {}),
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    };
    try {
      await details.save(base, draft, signal, admitted.active);
    } catch (error) {
      return done(
        error instanceof ChannelDetailsUnconfirmed
          ? { outcome: "unconfirmed", error: message(error) }
          : refused(admitted, error),
      );
    }
    return done({ outcome: "confirmed", ...(await settled(admitted, id)) });
  }

  async function change(
    action: OwnerLifecycleAction,
    id: string,
    caller?: OwnerMutationCaller,
  ): Promise<OwnerChannelWrite> {
    if (!["archive", "unarchive", "delete"].includes(action))
      throw new Error(`No channel action ${String(action)}.`);
    const admitted = admit(caller);
    const done = (fields: Answer) => answer(admitted, action, id, fields);
    await target(admitted, id);
    try {
      await admitted.binding.session.channelLifecycle.run(
        action,
        id,
        admitted.signal,
        admitted.active,
      );
    } catch (error) {
      if (error instanceof ChannelLifecycleUnconfirmed)
        return done({ outcome: "unconfirmed", error: message(error) });
      return done(
        message(error).includes("still in progress")
          ? { outcome: "rejected", reason: "busy", error: message(error) }
          : message(error).includes("no longer permitted")
            ? { outcome: "rejected", reason: "denied", error: message(error) }
            : refused(admitted, error),
      );
    }
    // The lifecycle owner confirmed it from the relay's own records; a deleted
    // channel has none left to read.
    return done({
      outcome: "confirmed",
      ...(action === "delete" ? {} : await settled(admitted, id)),
    });
  }

  /** A confirmed change's readback, when it can still be read. */
  const settled = (admitted: Admitted, id: string) =>
    readback(admitted, id).catch(() => ({}));

  return { create, update, change };
}

function intentOf(tags: readonly (readonly string[])[]): Intent {
  const value = (name: string) => tags.find(([key]) => key === name)?.[1];
  const ttl = value("ttl");
  return {
    name: value("name") ?? "",
    visibility: value("visibility") === "open" ? "open" : "private",
    about: value("about") ?? "",
    ttl: ttl === undefined ? undefined : Number(ttl),
    solo: tags.some(([key, label]) => key === "t" && label === SOLO_LABEL),
  };
}

/** Whether the relay's channel `id` is the one `wanted` describes, created by
 * the owner, who holds it as owner. */
function matches(
  binding: OwnerBinding,
  id: string,
  events: readonly RelayEvent[],
  wanted: Intent,
) {
  const relayAuthor = binding.session.relayAuthor;
  if (!relayAuthor) return false;
  try {
    const { details, metadata } = detailsSettings(
      events,
      id,
      binding.viewer,
      relayAuthor,
    );
    const rights = memberAuthority(events, id, binding.viewer, relayAuthor);
    const creator = channelIdentity(metadata).creator;
    return (
      channelTypeTag(metadata) === "stream" &&
      (!creator || creator === binding.viewer) &&
      rights.roles[binding.viewer] === "owner" &&
      same(
        {
          name: details.name,
          visibility: details.visibility === "public" ? "open" : "private",
          about: details.description,
          ttl: details.ttlSeconds,
          solo: !!details.labels?.includes(SOLO_LABEL),
        },
        wanted,
      )
    );
  } catch {
    return false;
  }
}

const same = (a: Intent, b: Intent) =>
  a.name === b.name &&
  a.visibility === b.visibility &&
  a.about === b.about &&
  a.ttl === b.ttl &&
  a.solo === b.solo;

const tag = (event: { tags: readonly (readonly string[])[] }, name: string) =>
  event.tags.find(([key]) => key === name)?.[1];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
