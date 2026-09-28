import type { EventTemplate } from "nostr-tools";

export type IdentityArchiveAction = "archive" | "unarchive";
const PUBKEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;

/** NIP-IA 9035/9036 wire form. The relay chooses and re-verifies the consent path. */
export function archiveRequestTemplate(
  action: IdentityArchiveAction,
  target: string,
  auth?: readonly string[],
): EventTemplate {
  const event = {
    kind: action === "archive" ? 9035 : 9036,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [["-"], ["p", target], ...(auth ? [[...auth]] : [])],
  };
  validateArchiveRequestTemplate(event);
  return event;
}

/** The host signs only this exact shape: no reason, rotation or other tags. */
export function validateArchiveRequestTemplate(event: EventTemplate): void {
  const [protectedTag, target, auth, ...extra] = Array.isArray(event?.tags)
    ? event.tags
    : [];
  if (
    !event ||
    (event.kind !== 9035 && event.kind !== 9036) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    extra.length ||
    JSON.stringify(protectedTag) !== JSON.stringify(["-"]) ||
    target?.length !== 2 ||
    target[0] !== "p" ||
    !PUBKEY.test(target[1] ?? "") ||
    (auth !== undefined &&
      (auth.length !== 4 ||
        auth[0] !== "auth" ||
        !PUBKEY.test(auth[1] ?? "") ||
        auth[1] === target[1] ||
        typeof auth[2] !== "string" ||
        !SIG.test(auth[3] ?? "")))
  )
    throw new Error("Invalid identity archive request");
}
