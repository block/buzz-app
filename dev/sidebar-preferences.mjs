import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import {
  projectSidebarPreferences,
  SIDEBAR_COORDINATES,
} from "../src/features/relay/sidebar-preferences.ts";

export const SIDEBAR_REQUEST_BYTES = 256 * 1024;
export const SIDEBAR_UPLOAD_SLOTS = 2;
export const SIDEBAR_UPLOAD_MS = 10_000;
/** Local host decoder, deliberately not an arbitrary NIP-44 decrypt capability. */
export function decodeSidebarPreferences(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > 3 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar records");
  const viewer = getPublicKey(secret);
  const coordinates = new Set();
  for (const event of events) {
    const tags = event?.tags?.filter?.(
      (tag) => Array.isArray(tag) && tag[0] === "d",
    );
    const coordinate = tags?.[0]?.[1];
    if (
      event?.kind !== 30078 ||
      event.pubkey !== viewer ||
      tags?.length !== 1 ||
      !SIDEBAR_COORDINATES.includes(coordinate) ||
      coordinates.has(coordinate) ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error("Invalid sidebar record");
    coordinates.add(coordinate);
  }
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const decoded = new Map();
    for (const event of events) {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      decoded.set(
        event.tags.find((tag) => tag[0] === "d")[1],
        JSON.parse(plaintext),
      );
    }
    return projectSidebarPreferences(
      decoded.get("channel-sections"),
      decoded.get("channel-stars"),
      decoded.get("channel-sort"),
    );
  } finally {
    key.fill(0);
  }
}

const SECTION_COORDINATE = "channel-sections";
function validAssignmentIntent(intent) {
  return (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    typeof intent.channelId === "string" &&
    intent.channelId.trim().length > 0 &&
    intent.channelId.length <= 256 &&
    (intent.sectionId === undefined ||
      (typeof intent.sectionId === "string" &&
        intent.sectionId.trim().length > 0 &&
        intent.sectionId.length <= 256)) &&
    Object.keys(intent).every((key) => ["channelId", "sectionId"].includes(key))
  );
}
export function assertSidebarAssignmentIntent(intent) {
  if (!validAssignmentIntent(intent))
    throw new Error("Invalid sidebar assignment intent");
}
function parseSectionsEvent(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar group head");
  if (!events.length) return { sections: [], assignments: {}, createdAt: 0 };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SECTION_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar group head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const groups = projectSidebarPreferences(JSON.parse(plaintext), undefined);
    return { ...groups, createdAt: event.created_at };
  } finally {
    key.fill(0);
  }
}
/** Narrow host command: mutate one assignment against the latest encrypted head. */
export function prepareSidebarAssignment(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarAssignmentIntent(intent);
  const viewer = getPublicKey(secret);
  const current = parseSectionsEvent(events, secret);
  if (
    intent.sectionId !== undefined &&
    !current.sections.some((section) => section.id === intent.sectionId)
  )
    throw new Error("Sidebar group no longer exists");
  const assignments = { ...current.assignments };
  if (intent.sectionId === undefined) delete assignments[intent.channelId];
  else assignments[intent.channelId] = intent.sectionId;
  const groups = projectSidebarPreferences(
    { version: 1, sections: current.sections, assignments },
    undefined,
  );
  if (current.assignments[intent.channelId] === intent.sectionId)
    return { groups };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(
      JSON.stringify({
        version: 1,
        sections: groups.sections,
        assignments: groups.assignments,
      }),
      key,
    );
  } finally {
    key.fill(0);
  }
  return {
    groups,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SECTION_COORDINATE],
          ["t", SECTION_COORDINATE],
        ],
      },
      secret,
    ),
  };
}

/** Publish one assignment, then re-read the coordinate before reporting saved state. */
export async function mutateSidebarAssignment(
  intent,
  secret,
  readHead,
  publish,
) {
  const draft = prepareSidebarAssignment(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepareSidebarAssignment(
    await readHead(),
    intent,
    secret,
  );
  if (confirmation.event)
    throw new Error(
      "Sidebar groups changed on another device; reload and try again",
    );
  return confirmation.groups;
}

const SORT_COORDINATE = "channel-sort";
const SORT_KEYS = new Set(["starred", "channels", "forums", "dms"]);
function validSortGroup(group, sectionIds) {
  return (
    SORT_KEYS.has(group) ||
    (group.startsWith("section:") && sectionIds.includes(group.slice(8)))
  );
}
export function assertSidebarSortIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.group !== "string" ||
    intent.group.length > 264 ||
    !["alpha", "recent"].includes(intent.mode) ||
    !Array.isArray(intent.sectionIds) ||
    intent.sectionIds.length > 100 ||
    intent.sectionIds.some(
      (id) => typeof id !== "string" || !id || id.length > 256,
    ) ||
    !validSortGroup(intent.group, intent.sectionIds) ||
    Object.keys(intent).some(
      (key) => !["group", "mode", "sectionIds"].includes(key),
    )
  )
    throw new Error("Invalid sidebar sort intent");
}
function parseSortEvent(events, secret, sectionIds) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar sort head");
  if (!events.length) return { groups: {}, createdAt: 0 };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SORT_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar sort head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const parsed = projectSidebarPreferences(
      undefined,
      undefined,
      JSON.parse(plaintext),
      sectionIds,
    );
    return { groups: parsed.sort ?? {}, createdAt: event.created_at };
  } finally {
    key.fill(0);
  }
}
export function prepareSidebarSort(events, intent, secret, now = Date.now()) {
  assertSidebarSortIntent(intent);
  const viewer = getPublicKey(secret);
  const current = parseSortEvent(events, secret, intent.sectionIds);
  const live = new Set(intent.sectionIds.map((id) => `section:${id}`));
  const groups = Object.fromEntries(
    Object.entries(current.groups).filter(
      ([group]) => !group.startsWith("section:") || live.has(group),
    ),
  );
  if (intent.mode === "alpha") delete groups[intent.group];
  else groups[intent.group] = intent.mode;
  if (
    Object.keys(groups).length === Object.keys(current.groups).length &&
    Object.entries(groups).every(
      ([group, mode]) => current.groups[group] === mode,
    )
  )
    return { groups };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify({ version: 1, groups }), key);
  } finally {
    key.fill(0);
  }
  return {
    groups,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SORT_COORDINATE],
          ["t", SORT_COORDINATE],
        ],
      },
      secret,
    ),
  };
}
export async function mutateSidebarSort(intent, secret, readHead, publish) {
  const draft = prepareSidebarSort(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepareSidebarSort(await readHead(), intent, secret);
  if (confirmation.event)
    throw new Error(
      "Sidebar sort changed on another device; reload and try again",
    );
  return confirmation.groups;
}
