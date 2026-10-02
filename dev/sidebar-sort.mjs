import {
  editSidebarRecord,
  projectSidebarRecord,
} from "../src/features/relay/sidebar-registers.ts";
import { getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
import { SIDEBAR_REQUEST_BYTES } from "./sidebar-preferences.mjs";

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
      (id) => typeof id !== "string" || !id.trim() || id.length > 256,
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
  if (!events.length) return { blob: { version: 1, groups: {} }, createdAt: 0 };
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
    const blob = JSON.parse(plaintext);
    projectSidebarPreferences(
      undefined,
      undefined,
      undefined,
      blob,
      sectionIds,
    );
    return {
      blob: projectSidebarRecord(SORT_COORDINATE, blob),
      createdAt: event.created_at,
    };
  } finally {
    key.fill(0);
  }
}
function readSidebarSortState(events, intent, secret, now = Date.now()) {
  assertSidebarSortIntent(intent);
  const current = parseSortEvent(events, secret, intent.sectionIds);
  const blob = editSidebarRecord(
    SORT_COORDINATE,
    current.blob,
    current.createdAt,
    [[["g", intent.group], intent.mode === "alpha" ? null : intent.mode]],
    now,
  );
  const projected =
    projectSidebarPreferences(
      undefined,
      undefined,
      undefined,
      blob,
      intent.sectionIds,
    ).sort ?? {};
  if (Buffer.byteLength(JSON.stringify(blob)) > 128 * 1024)
    throw new Error("Sidebar plaintext budget exceeded");
  if (blob === current.blob) return { groups: projected, changed: false };
  return { groups: projected, changed: true, current, blob };
}

// Desktop compatibility uses one encrypted whole-blob LWW record, not per-group
// conflict resolution. Only choices present in this read can be preserved.
export async function prepareSidebarSort(
  events,
  intent,
  secret,
  signer,
  signal,
  now = Date.now(),
) {
  const state = readSidebarSortState(events, intent, secret, now);
  if (!state.changed) return state;
  const viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify(state.blob), key);
  } finally {
    key.fill(0);
  }
  const event = await signer.signEvent(
    {
      kind: 30078,
      content,
      created_at: Math.max(Math.floor(now / 1000), state.current.createdAt + 1),
      tags: [
        ["d", SORT_COORDINATE],
        ["t", SORT_COORDINATE],
      ],
    },
    signal,
  );
  signal?.throwIfAborted();
  return { groups: state.groups, event };
}
export async function mutateSidebarSort(
  intent,
  secret,
  signer,
  signal,
  readHead,
  publish,
) {
  assertSidebarSortIntent(intent);
  const draft = await prepareSidebarSort(
    await readHead(),
    intent,
    secret,
    signer,
    signal,
  );
  signal?.throwIfAborted();
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  // This checks only the requested group now, not whether the whole-blob write
  // lost another device's intervening change to an unrelated group.
  const confirmation = readSidebarSortState(await readHead(), intent, secret);
  signal?.throwIfAborted();
  if (confirmation.changed)
    throw new Error(
      "Sidebar sort changed on another device; reload and try again",
    );
  return confirmation.groups;
}
