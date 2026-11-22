import {
  conversationNameDetails,
  MOVE_DM_HISTORY_KIND,
  NAME_DM_KIND,
  validDirectMessageParticipants,
} from "../src/features/relay/direct-message-policy.ts";
import { randomUUID } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Idempotent participant-set command (kind 41010), or with `channel`, adding
 * people to that DM (kind 41011). Only with `includeHistory` may anyone join
 * an existing DM and read its history; an addition's `"ask"` lets the relay
 * decide whether to ask first. Keys stay in the broker. */
export function directMessageEvent(input, viewer, key) {
  if (input?.command !== undefined)
    return directMessageCommandEvent(input, viewer, key);
  const adding = input?.channel !== undefined;
  if (
    !input ||
    !Array.isArray(input.pubkeys) ||
    input.pubkeys.some((value) => typeof value !== "string") ||
    !validDirectMessageParticipants(input.pubkeys, viewer, adding)
  )
    throw new Error(
      adding
        ? "Choose who to add to this DM."
        : "Choose between one and eight other people.",
    );
  if (
    adding
      ? typeof input.channel !== "string" ||
        !UUID.test(input.channel) ||
        (typeof input.includeHistory !== "boolean" &&
          input.includeHistory !== "ask")
      : input.includeHistory !== undefined &&
        typeof input.includeHistory !== "boolean"
  )
    throw new Error("Choose a direct message to add people to.");
  return finalizeEvent(
    {
      kind: adding ? 41011 : 41010,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...(adding ? [["h", input.channel]] : []),
        ...input.pubkeys.map((pubkey) => ["p", pubkey]),
        ...(input.includeHistory
          ? [["history", input.includeHistory === "ask" ? "ask" : "include"]]
          : []),
        ["client", randomUUID()],
      ],
    },
    key,
  );
}

const EVENT_ID = /^[0-9a-f]{64}$/;

/** Naming a DM (kind 41013) or moving its history from a message (kind
 * 41014): `command` is `"name"` or `"move"`. Only a person sends either, and
 * the relay decides who that is. */
function directMessageCommandEvent(input, viewer, key) {
  if (!UUID.test(input.channel ?? ""))
    throw new Error("Choose a conversation.");
  const tags = [["h", input.channel]];
  let kind;
  if (input.command === "name") {
    kind = NAME_DM_KIND;
    const details = conversationNameDetails({
      name: typeof input.name === "string" ? input.name : "",
      picture: typeof input.picture === "string" ? input.picture : undefined,
      about: typeof input.about === "string" ? input.about : undefined,
    });
    tags.push(["name", details.name]);
    if (details.picture) tags.push(["picture", details.picture]);
    if (details.about !== undefined) tags.push(["about", details.about]);
  } else if (input.command === "move") {
    kind = MOVE_DM_HISTORY_KIND;
    const add = input.add ?? [];
    if (
      typeof input.cut !== "string" ||
      !EVENT_ID.test(input.cut) ||
      !Array.isArray(add) ||
      add.some((value) => typeof value !== "string") ||
      (add.length > 0 && !validDirectMessageParticipants(add, viewer, true))
    )
      throw new Error("Choose where to move this history.");
    tags.push(["e", input.cut]);
    if (input.name !== undefined) {
      tags.push([
        "name",
        conversationNameDetails({
          name: typeof input.name === "string" ? input.name : "",
        }).name,
      ]);
    } else if (!add.length)
      throw new Error("Add someone, or give the new conversation a name.");
    for (const pubkey of add) tags.push(["p", pubkey]);
  } else throw new Error("Choose a conversation.");
  return finalizeEvent(
    { kind, content: "", created_at: Math.floor(Date.now() / 1000), tags },
    key,
  );
}

export function directMessageReceipt(text, eventId) {
  const receipt = JSON.parse(text);
  if (
    receipt?.event_id !== eventId ||
    receipt.accepted !== true ||
    typeof receipt.message !== "string" ||
    !receipt.message.startsWith("response:")
  )
    throw new Error("The direct message could not be opened. Try again.");
  const result = JSON.parse(receipt.message.slice(9));
  if (typeof result?.channel_id !== "string" || !UUID.test(result.channel_id))
    throw new Error("The relay returned an invalid direct message.");
  return {
    channelId: result.channel_id,
    ...(typeof result.created === "boolean" ? { created: result.created } : {}),
  };
}
