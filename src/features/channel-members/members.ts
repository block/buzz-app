import { archiveHides } from "../relay/identity-archives";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { LocalEvents, OutgoingEvent } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import {
  FinalFailure,
  NamedError,
  retryable,
  unsentSentence,
} from "../relay/refusal";

const keyPattern = /^[0-9a-f]{64}$/;

/** Channel types whose members may add people. A system channel's members
 * are its readers, for example the agents a plugin shares its records with. */
const expandable = new Set(["stream", "forum", "system"]);

/** The relay remains authoritative; never offer role changes or DM expansion. */
export function canAddMembers(
  session: {
    viewer?: string | undefined;
    outbox?: { supports(kind: number): boolean } | undefined;
  },
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    channel.viewerRole !== "guest" &&
    !channel.archived &&
    expandable.has(channel.channelType ?? "") &&
    (channel.members?.includes(session.viewer) ||
      (channel.readOnly && !channel.private && channel.joinRole !== "guest"))
  );
}

/** A session share adds only to this session. It never opens ordinary Members UI
 * or inherits parent-channel membership. */
export function canShareSoloChat(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel?.channelType === "solo" &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    channel.members?.includes(session.viewer)
  );
}

const channelOf = (session: RelaySession, channelId: string) =>
  session.channels.list().channels.find((item) => item.id === channelId) ??
  session.channels.get?.(channelId);

/** The name a profile gives, if it gives one: never the fragment of the key a
 * profile without a name stands in with. */
export const profileName = (
  profile: { name?: string; nameIsFallback?: true | undefined } | undefined,
) => (profile?.nameIsFallback ? undefined : profile?.name);

/** The name people know someone by in this community, if Buzz has one: their
 * profile's own name or a known agent's, never part of their key. */
export const memberName = (
  session: Pick<RelaySession, "names" | "profiles" | "agentChoices">,
  pubkey: string,
) =>
  session.names.resolve(
    pubkey,
    profileName(session.profiles.snapshot().get(pubkey)) ??
      session.agentChoices
        .snapshot()
        .identities.find((agent) => agent.pubkey === pubkey)?.name,
  );

const knownAgent = (session: RelaySession, pubkey: string) =>
  session.agentChoices
    .snapshot()
    .identities.some((agent) => agent.pubkey === pubkey) ||
  !!session.profiles.snapshot().get(pubkey)?.isAgent;

/** An explicit Guest stays one; agents join as Bot. Solo sharing and
 * private-channel invitations grant participation explicitly, independently
 * of the admission default for public visitors. */
function additionRole(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  soloParticipant: boolean,
  intent?: MemberAdditionIntent,
) {
  const current = channelOf(session, channelId);
  return intent?.role
    ? intent.role
    : knownAgent(session, pubkey)
      ? "bot"
      : soloParticipant ||
          (current?.visibility === "private" &&
            (current.channelType === "stream" ||
              current.channelType === "forum"))
        ? "member"
        : undefined;
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Buzz stopped adding them because the community connection changed.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery === "unknown")
        finish(
          new Error("Buzz hasn’t confirmed this yet. Try again to check."),
        );
      else if (item.delivery === "failed") {
        const message =
          unsentSentence(item) ??
          (item.refused
            ? "The community didn’t let Buzz add them."
            : "Buzz couldn’t add them. Try again.");
        // One that would just be refused again offers no Retry.
        finish(
          retryable(item) ? new Error(message) : new FinalFailure(message),
        );
      }
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

const batchPrefix = "member-add:batch:";
/** A batch addition is settled by the roster read after it, never resumed. */
export const isBatchAddition = (item: OutgoingEvent) =>
  !!item.recovery?.key.startsWith(batchPrefix);

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
  /** Adds the person as a guest, who can read but not post. */
  role?: "guest";
  /** Outbox recovery is not an explicit request to re-invite a removed member. */
  retry?: true;
};

/** Explicit single-person intent. Membership truth and pending writes stay
 * session-owned. Whatever the outcome, settles the batches it may complete. */
export async function addChannelMember(
  ...args: Parameters<typeof addOneMember>
) {
  const [session, channelId] = args;
  try {
    await addOneMember(...args);
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}

async function addOneMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
  soloParticipant = false,
): Promise<void> {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const name = memberName(session, pubkey) ?? "this person";
  const channel = () => channelOf(session, channelId);
  const checkAccess = () => {
    signal.throwIfAborted();
    if (
      !(soloParticipant
        ? canShareSoloChat(session, channel())
        : canAddMembers(session, channel()))
    )
      throw new Error("You can’t add people to this channel right now.");
    if (archiveHides(session.archives, pubkey, session.viewer))
      throw new Error(
        "Archived identities cannot be added. Choose someone else.",
      );
  };
  checkAccess();
  const outbox = session.outbox;
  if (!outbox)
    throw new Error("Buzz can’t add people in this community right now.");
  await outbox.ready();
  checkAccess();
  // This existing session operation verifies the connected relay's signed roster.
  await session.channelWrites.refreshMembership(channelId);
  checkAccess();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const matchesTarget = (event: Pick<RelayEvent, "kind" | "tags">) =>
    event.kind === 9000 &&
    event.tags.some(([tag, value]) => tag === "h" && value === channelId) &&
    event.tags.some(([tag, value]) => tag === "p" && value === pubkey);
  const noRole = (event: Pick<RelayEvent, "tags">) =>
    !event.tags.some(([tag]) => tag === "role");
  const saved = journal.snapshot();
  const pending = fresh
    ? undefined
    : (saved.find((item) =>
        intent.id
          ? item.event.id === intent.id
          : !item.acknowledged &&
            !isBatchAddition(item) &&
            matchesTarget(item.event),
      ) ??
      // Keep a resolved legacy Guest outcome actionable after restart.
      (soloParticipant && channel()?.members?.includes(pubkey)
        ? saved.find(
            (item) =>
              item.acknowledged &&
              !isBatchAddition(item) &&
              matchesTarget(item.event) &&
              noRole(item.event),
          )
        : undefined));
  // A saved addition finishes only with the role this one asks for.
  const savedRole = pending?.event.tags.find(([tag]) => tag === "role")?.[1];
  const sameRole = intent.role
    ? savedRole === intent.role
    : savedRole === undefined || savedRole === "bot" || savedRole === "member";

  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  // A saved share may finish its exact Bot grant; it cannot authorize a new one.
  const recoveringSoloAgent =
    pending &&
    !pending.acknowledged &&
    !pending.guarded &&
    pending.recovery?.key === recovery.key &&
    pending.event.tags.some(
      ([tag, value]) => tag === "role" && value === "bot",
    );
  const check = () => {
    checkAccess();
    if (soloParticipant && !recoveringSoloAgent && knownAgent(session, pubkey))
      throw new Error(
        "Add agents by tagging them in the chat composer instead.",
      );
  };
  check();
  // A completed or missing receipt is not permission for Retry to create a grant.
  if (intent.retry && !pending) return;
  const confirmAddition = async (id: string) => {
    intent.id = id;
    intent.dismissed = false;
    intent.confirmed = false;
    await waitForAddition(journal, id, signal);
    check();
    await session.channelWrites.refreshMembership(channelId);
    check();
    if (!channel()?.members?.includes(pubkey))
      throw new NamedError(
        `Buzz hasn’t seen ${name} join yet. Try again to check.`,
      );
    await outbox.acknowledge(id);
    check();
    intent.confirmed = true;
  };
  // A request that is proven unsent, and that the member list just read
  // shows never took effect, can make way for this one. Retry only finishes
  // an earlier request, so it never replaces one.
  const replace = async () => {
    if (!pending) return;
    const id = pending.event.id;
    // `pending` was read before the awaits above. A Retry elsewhere may have
    // taken it up since, and dismiss leaves an item alone while it is being
    // sent, so read it again on both sides.
    const now = () => journal.snapshot().find((item) => item.event.id === id);
    const current = now();
    if (!current)
      throw new NamedError(
        `Buzz hasn’t seen ${name} join yet. Try again to check.`,
      );
    if (current.delivery !== "failed")
      throw new NamedError(
        `Buzz is still adding ${name}. Wait for that to finish, then try again.`,
      );
    await outbox.dismiss(id);
    if (now())
      throw new NamedError(
        `Buzz is still adding ${name}. Wait for that to finish, then try again.`,
      );
    delete intent.id;
    intent.dismissed = true;
    return addOneMember(
      session,
      channelId,
      pubkey,
      signal,
      intent,
      receipts,
      soloParticipant,
    );
  };
  // Another flow fenced this request for its own retry, such as an agent
  // added from the composer.
  if (pending?.guarded && !channel()?.members?.includes(pubkey)) {
    if (pending.delivery === "failed" && !intent.retry) return replace();
    throw new NamedError(
      `Buzz is still adding ${name}. Wait for that to finish, then try again.`,
    );
  }
  if (soloParticipant && pending && noRole(pending.event))
    intent.id = pending.event.id;
  if (pending && !sameRole && !channel()?.members?.includes(pubkey))
    throw new NamedError(
      `Buzz is still adding ${name}. Wait for that to finish, then try again.`,
    );

  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (soloParticipant && pending && noRole(pending.event)) {
    if (!channel()?.members?.includes(pubkey)) {
      let replacement: string | undefined;
      let recorded = false;
      await outbox.acknowledge(
        pending.event.id,
        async (event) => {
          check();
          recorded = await session.channelWrites.additionRecorded(
            event,
            signal,
          );
          // Finish the fresh membership check while the original is recoverable.
          await session.channelWrites.refreshMembership(channelId);
          check();
          return recorded ? "recorded" : undefined;
        },
        {
          input: () => {
            check();
            if (
              channel()?.members?.includes(pubkey) ||
              (intent.retry && recorded)
            )
              return undefined;
            return invitation();
          },
          queued: (id) => {
            replacement = id;
          },
        },
      );
      if (replacement) return confirmAddition(replacement);
      check();
      intent.confirmed = true;
      // Retiring a recorded command must not fall through to a new grant.
      if (intent.retry && recorded && !channel()?.members?.includes(pubkey))
        return;
      // A joined target still needs role reconciliation; never overwrite a Guest.
      return addOneMember(
        session,
        channelId,
        pubkey,
        signal,
        intent,
        receipts,
        soloParticipant,
      );
    }
    await session.memberAdministration.refresh(channelId);
    check();
    const verified = session.memberAdministration.snapshot(channelId);
    const role = verified.authority.roles[pubkey];
    if (
      verified.status !== "ready" ||
      verified.operation?.status === "pending" ||
      !role ||
      role === "unknown"
    )
      throw new NamedError(
        `Buzz couldn’t confirm ${name}’s access. Try again in a moment.`,
      );
    // Membership resolves the original command, even when its grant was Guest.
    // Do not promote a newer role or replay the old command after removal.
    if (role === "guest") {
      await outbox.acknowledge(pending.event.id);
      check();
      intent.confirmed = true;
      throw new Error(
        "This earlier invitation granted view-only access. To grant participation, remove them in People and invite them again.",
      );
    }
  }
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  // The earlier request was sent and has since left the outbox, yet the
  // member list doesn't show them: they may have been removed meanwhile.
  if (!fresh && intent.id && !pending)
    throw new NamedError(
      `Buzz sent ${name}’s invitation, but they aren’t in this channel now. Someone may have removed them.`,
    );
  // The relay no longer takes a request this old.
  if (
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= 15 * 60
  ) {
    if (!intent.retry) return replace();
    throw new NamedError(`Buzz couldn’t add ${name}. Try adding them again.`);
  }

  const id = pending?.event.id ?? outbox.send(invitation(), recovery);
  if (pending?.delivery === "failed" || pending?.delivery === "unknown")
    outbox.retry(id);
  return confirmAddition(id);

  function invitation() {
    const role = additionRole(
      session,
      channelId,
      pubkey,
      soloParticipant,
      intent,
    );
    return {
      kind: 9000,
      content: "",
      tags: [
        ["h", channelId],
        ["p", pubkey],
        ...(role ? [["role", role]] : []),
      ],
    };
  }
}

/** A batch is the only durable record of the people it names until each is
 * in the roster or has their own addition pending, so only then is it
 * acknowledged. Batches still sending are left to their own sender. */
export async function settleBatchAdditions(
  session: RelaySession,
  channelId: string,
) {
  const outbox = session.outbox;
  if (!outbox) return;
  const items = outbox
    .snapshot()
    .filter(
      (item) =>
        !item.acknowledged &&
        item.event.kind === 9000 &&
        item.event.tags.some(
          ([tag, value]) => tag === "h" && value === channelId,
        ),
    );
  const named = (item: OutgoingEvent) =>
    item.event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : []));
  const covered = new Set([
    ...(channelOf(session, channelId)?.members ?? []),
    ...items.filter((item) => !isBatchAddition(item)).flatMap(named),
  ]);
  for (const item of items)
    if (
      isBatchAddition(item) &&
      item.delivery !== "sending" &&
      named(item).every((key) => covered.has(key))
    )
      await outbox.acknowledge(item.event.id).catch(() => {});
}

/** Most people one kind:9000 may name; see the relay's put-user handler. */
const batchLimit = 100;

/**
 * Adds people missing from a channel with one kind:9000 per role and at most
 * 100 people, then reads the roster once. Returns everyone it shows, including
 * people already there. A relay without batch support adds only the first
 * person each event names. Best effort: only an abort throws.
 * Everyone not returned is left to `addChannelMember`, which also says
 * why they failed, as is anyone with an earlier single addition pending, so a
 * stale role is never resent. A batch is never resumed and never blocks one;
 * it stays in Outbox until everyone it names is settled.
 */
export async function addChannelMembersAtOnce(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: ReadonlyMap<string, MemberAdditionIntent>,
  signal: AbortSignal,
  soloParticipant = false,
  /** Receipts the single addition reads, including resolved ones. */
  receipts?: LocalEvents,
): Promise<ReadonlySet<string>> {
  const confirmed = new Set<string>();
  const outbox = session.outbox;
  if (people.length < 2 || !outbox) return confirmed;
  const allowed = () =>
    soloParticipant
      ? canShareSoloChat(session, channelOf(session, channelId))
      : canAddMembers(session, channelOf(session, channelId));
  const attempt = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  // Restored receipts count, so read them only once the outbox has loaded.
  const loaded = await attempt(async () => {
    await outbox.ready();
    return true;
  });
  if (!loaded) return confirmed;
  const singles = (receipts ?? outbox)
    .snapshot()
    .filter(
      (item) =>
        !isBatchAddition(item) &&
        item.event.kind === 9000 &&
        item.event.tags.some(
          ([tag, value]) => tag === "h" && value === channelId,
        ),
    );
  const named = (items: readonly OutgoingEvent[]) =>
    new Set(
      items.flatMap(({ event }) =>
        event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : [])),
      ),
    );
  const pending = named(singles.filter((item) => !item.acknowledged));
  // A Solo chat's resolved no-role invitation may have granted Guest, which
  // only the single addition reconciles and reports.
  const legacy = soloParticipant
    ? named(
        singles.filter(
          (item) =>
            item.acknowledged &&
            !item.event.tags.some(([tag]) => tag === "role"),
        ),
      )
    : new Set<string>();
  // Anyone with a single addition pending, or whom one would refuse, stays
  // with it: it alone may resume that write, and it reports why. Retry only
  // finishes an existing receipt, so it never joins a batch.
  const eligible = people.filter(
    (key) =>
      keyPattern.test(key) &&
      !intents.get(key)?.id &&
      !intents.get(key)?.retry &&
      !pending.has(key) &&
      !legacy.has(key) &&
      !archiveHides(session.archives, key, session.viewer) &&
      // A Solo chat's agents keep their own receipts, so a recovering share
      // can finish its exact Bot grant.
      !(soloParticipant && knownAgent(session, key)),
  );
  if (eligible.length < 2) return confirmed;
  const before = allowed()
    ? await attempt(() => session.channelWrites.refreshMembership(channelId))
    : undefined;
  signal.throwIfAborted();
  if (!before || !allowed()) return confirmed;
  const groups = new Map<string | undefined, string[]>();
  for (const key of eligible)
    if (!before.members?.includes(key)) {
      const role = additionRole(
        session,
        channelId,
        key,
        soloParticipant,
        intents.get(key),
      );
      groups.set(role, [...(groups.get(role) ?? []), key]);
    }
  let sent = false;
  try {
    let roster: ChannelSummary | undefined = before;
    let dispatched = false;
    // One missing person gains nothing from a batch; the single addition sends it.
    if ([...groups.values()].flat().length > 1)
      for (const [role, keys] of groups)
        for (let start = 0; start < keys.length; start += batchLimit) {
          // Each later write reads the roster again, so it never names someone
          // admitted meanwhile, whose role an explicit one would overwrite.
          if (dispatched)
            roster = await attempt(() =>
              session.channelWrites.refreshMembership(channelId),
            );
          if (!roster || !allowed()) break;
          const recipients = keys.slice(start, start + batchLimit).filter(
            (key) =>
              !roster?.members?.includes(key) &&
              // Archives may refresh during any read, as the single addition rechecks.
              !archiveHides(session.archives, key, session.viewer),
          );
          if (!recipients.length) continue;
          dispatched = true;
          const id = await attempt(() =>
            outbox.send(
              {
                kind: 9000,
                content: "",
                tags: [
                  ["h", channelId],
                  ...recipients.map((key) => ["p", key]),
                  ...(role ? [["role", role]] : []),
                ],
              },
              { key: `${batchPrefix}${crypto.randomUUID()}`, value: "1" },
            ),
          );
          if (!id) continue;
          sent = true;
          // A refusal or unknown result still leaves the roster to decide.
          await attempt(() => waitForAddition(outbox, id, signal));
        }
    const after = sent
      ? await attempt(() => session.channelWrites.refreshMembership(channelId))
      : before;
    for (const key of eligible)
      if (after?.members?.includes(key)) confirmed.add(key);
    return confirmed;
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}
