import { getEventHash } from "nostr-tools";
import { memberAdministrationTemplate } from "../channel-members/administration-protocol";
import type { OutboxRecovery, OutgoingEvent } from "./outbox";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export const soloAdminKey = (channel: string) =>
  `solo-initial-admins:${channel}`;

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

/** Reconstruct the exact same promotions after interruption. Their timestamp
 * and channel come from the saved create, so retries never invent a new grant
 * that could undo a later demotion or removal. */
export async function promoteSoloAdmins(
  creation: OutgoingEvent,
  writer: RelayWriter,
  reader: RelayReader,
  relayAuthor: string,
  signal: AbortSignal,
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
  for (const admin of admins as string[]) {
    signal.throwIfAborted();
    const template = {
      ...memberAdministrationTemplate(channel, {
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
      throw new Error("Chat admin setup expired. Start a new chat to retry.");
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
