import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";

const COORDINATE = "rail-layout";
const text = (value, max) =>
  typeof value === "string" && !!value && value.length <= max;
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const list = (value, max, valid) =>
  Array.isArray(value) && value.length <= max && value.every(valid);
/** The bounded arrangement the host will sign; nothing else may be saved here. */
const valid = (payload) =>
  record(payload) &&
  Object.keys(payload).length === 6 &&
  payload.version === 1 &&
  typeof payload.teamExpanded === "boolean" &&
  list(payload.order, 200, (id) => text(id, 264)) &&
  list(
    payload.sections,
    100,
    (section) =>
      record(section) &&
      Object.keys(section).length === 2 &&
      text(section.id, 264) &&
      text(section.title, 256),
  ) &&
  list(
    payload.placements,
    2000,
    (placed) =>
      record(placed) &&
      Object.keys(placed).length === 2 &&
      text(placed.section, 264) &&
      record(placed.entry),
  ) &&
  list(payload.pins, 500, record);

/** A read carries nothing; a write carries the arrangement and the record
 * time it replaces. */
export function assertRailLayoutIntent(intent) {
  if (
    !record(intent) ||
    (intent.payload === undefined
      ? Object.keys(intent).length !== 0
      : Object.keys(intent).length !== 2 ||
        !Number.isSafeInteger(intent.base) ||
        intent.base < 0 ||
        !valid(intent.payload))
  )
    throw new Error("Invalid sidebar arrangement intent");
}

/** Reads the account's arrangement, or replaces the one read at `base`. */
export async function mutateRailLayout(intent, secret, readHead, publish) {
  assertRailLayoutIntent(intent);
  const viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  const read = async () => {
    const events = await readHead();
    if (!Array.isArray(events) || events.length > 1)
      throw new Error("Invalid sidebar arrangement head");
    const event = events[0];
    if (!event) return { createdAt: 0 };
    if (
      event.kind !== 30078 ||
      event.pubkey !== viewer ||
      event.tags?.filter?.((tag) => tag[0] === "d").length !== 1 ||
      !event.tags.some((tag) => tag[0] === "d" && tag[1] === COORDINATE) ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error("Invalid sidebar arrangement record");
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar arrangement budget exceeded");
    const payload = JSON.parse(plaintext);
    if (!record(payload)) throw new Error("Invalid sidebar arrangement");
    return { payload, createdAt: event.created_at, id: event.id };
  };
  try {
    const head = await read();
    if (intent.payload === undefined)
      return { payload: head.payload, createdAt: head.createdAt };
    if (head.createdAt !== intent.base) return { conflict: true };
    const plaintext = JSON.stringify(intent.payload);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar arrangement budget exceeded");
    const event = finalizeEvent(
      {
        kind: 30078,
        content: nip44.v2.encrypt(plaintext, key),
        created_at: Math.max(Math.floor(Date.now() / 1000), intent.base + 1),
        tags: [
          ["d", COORDINATE],
          ["t", COORDINATE],
        ],
      },
      secret,
    );
    await publish(event);
    const confirmed = await read();
    return confirmed.id === event.id
      ? { createdAt: confirmed.createdAt }
      : { conflict: true };
  } finally {
    key.fill(0);
  }
}
