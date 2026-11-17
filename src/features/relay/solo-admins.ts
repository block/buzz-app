import { getEventHash } from "nostr-tools";
import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "./events";
import type { ProfileQueries } from "./profile-directory";
import { memberAdministrationTemplate } from "../channel-members/administration-protocol";
import type { OutboxRecovery, OutgoingEvent } from "./outbox";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export const soloAdminKey = (channel: string) =>
  `solo-initial-admins:${channel}`;

/** Library inclusion is discovery, never authority to grant chat Admin. */
export async function ownedSoloAgents(
  profiles: Pick<ProfileQueries, "ensure" | "event"> | undefined,
  viewer: string | undefined,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  const owned = new Set<string>();
  if (!profiles || !viewer || !keys.length) return owned;
  const unique = [...new Set(keys)];
  await profiles.ensure(unique);
  await Promise.all(
    unique.map(async (key) => {
      const head = profiles.event?.(key);
      if (
        head &&
        hasEventProof(head) &&
        head.kind === 0 &&
        head.pubkey === key &&
        (await attestedOwner(head)) === viewer &&
        profiles.event?.(key) === head
      )
        owned.add(key);
    }),
  );
  return new Set(unique.filter((key) => owned.has(key)));
}

/** Local recovery only; the relay still receives an ordinary channel create. */
export function soloAdminRecovery(
  channel: string,
  members: readonly string[],
  admins: readonly string[] = [],
): OutboxRecovery | undefined {
  if (!admins.length) return;
  const unique = [...new Set(admins)];
  if (
    unique.length > 32 ||
    unique.some((key) => !/^[0-9a-f]{64}$/.test(key) || !members.includes(key))
  )
    throw new Error("Opening admins must be initial chat agents.");
  return { key: soloAdminKey(channel), value: JSON.stringify(unique) };
}

/** Only explicit abandonment of a delivered, expired setup may waive its gate.
 * No unrecorded grant can start after this deadline; recorded roles stay put. */
export function isExpiredSoloAdminSetup(item: OutgoingEvent): boolean {
  const create = item.event;
  const channel = create.tags.find(([tag]) => tag === "h")?.[1];
  if (
    create.kind !== 9007 ||
    !channel ||
    !["accepted", "seen"].includes(item.delivery) ||
    item.recovery?.key !== soloAdminKey(channel) ||
    !(Date.now() / 1000 - (create.created_at ?? Infinity) >= 15 * 60)
  )
    return false;
  try {
    const admins: unknown = JSON.parse(item.recovery.value);
    return (
      Array.isArray(admins) &&
      admins.length > 0 &&
      admins.every((key) => typeof key === "string" && key !== create.pubkey) &&
      soloAdminRecovery(
        channel,
        create.tags.flatMap(([tag, key]) => (tag === "p" && key ? [key] : [])),
        admins,
      )?.value === item.recovery.value
    );
  } catch {
    return false;
  }
}

/** Reconstruct the exact same promotions after interruption. Their timestamp
 * and channel come from the saved create, so retries never invent a new grant
 * that could undo a later demotion or removal. */
export async function promoteSoloAdmins(
  creation: OutgoingEvent,
  writer: RelayWriter,
  reader: RelayReader,
  relayAuthor: string,
  signal: AbortSignal,
  owned?: (keys: readonly string[]) => Promise<ReadonlySet<string>>,
) {
  const create = creation.event;
  const channel = create.tags.find(([tag]) => tag === "h")?.[1];
  const admins: unknown = JSON.parse(creation.recovery?.value ?? "null");
  if (
    create.kind !== 9007 ||
    !channel ||
    creation.recovery?.key !== soloAdminKey(channel) ||
    !Array.isArray(admins) ||
    !admins.length ||
    admins.some((key) => typeof key !== "string" || key === create.pubkey) ||
    soloAdminRecovery(
      channel,
      create.tags.flatMap(([tag, key]) => (tag === "p" && key ? [key] : [])),
      admins,
    )?.value !== creation.recovery.value
  )
    throw new Error("The saved chat admin setup is invalid.");
  const read = (filters: Parameters<RelayReader["read"]>[0]) =>
    reader.read(filters, { signal, fresh: true, priority: "foreground" });
  let ownership: Promise<ReadonlySet<string>> | undefined;
  for (const admin of admins as string[]) {
    signal.throwIfAborted();
    const template = {
      ...memberAdministrationTemplate(channel, create.pubkey, {
        pubkey: admin,
        expectedRole: "member",
        role: "admin",
      }),
      created_at: create.created_at,
    };
    const id = getEventHash({ ...template, pubkey: create.pubkey });
    const recorded = async () =>
      (
        await read([
          {
            kinds: [9000],
            ids: [id],
            authors: [create.pubkey],
            limit: 1,
            consistency: "strong",
          },
        ])
      ).some((event) => event.id === id && event.pubkey === create.pubkey);
    // A recorded grant remains complete even when its recipient was demoted.
    if (await recorded()) continue;
    if (Date.now() / 1000 - create.created_at >= 15 * 60)
      throw new Error(
        "Chat admin setup expired. Abandon setup in Outbox to continue with current roles, or start a new chat.",
      );
    ownership ??= owned?.(admins as string[]);
    if (!(await ownership)?.has(admin))
      throw new Error(
        "An opening agent is not verified as owned by the chat creator. Check chat access before retrying.",
      );
    const rosters = await read([
      {
        kinds: [39002],
        authors: [relayAuthor],
        "#d": [channel],
        limit: 1,
        consistency: "strong",
      },
    ]);
    const roster = rosters.find(
      (event) =>
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([tag, value]) => tag === "d" && value === channel),
    );
    const role = roster?.tags.find(
      ([tag, key]) => tag === "p" && key === admin,
    )?.[3];
    if (!role || !["member", "bot", "admin"].includes(role))
      throw new Error(
        "An opening agent's access changed. Check chat access before retrying.",
      );
    const signed = await writer.sign(template, signal);
    signal.throwIfAborted();
    if (signed.id !== id || signed.pubkey !== create.pubkey)
      throw new Error("The signer changed the chat admin command.");
    try {
      await writer.publish(signed, signal);
    } catch (error) {
      if (!(await recorded())) throw error;
    }
    // An OK alone is not proof of the requested role change.
    if (!(await recorded()))
      throw new Error(
        "Chat admin setup is unconfirmed. Retry the opening message.",
      );
  }
}
