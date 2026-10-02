import { getPublicKey, nip44 } from "nostr-tools";
import { decodeSidebarPreferences } from "./sidebar-preferences.mjs";

const COORDINATE = "channel-stars";
export function assertSidebarStarIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.channelId !== "string" ||
    !intent.channelId.trim() ||
    intent.channelId.length > 256 ||
    typeof intent.starred !== "boolean" ||
    Object.keys(intent).some((key) => !["channelId", "starred"].includes(key))
  )
    throw new Error("Invalid sidebar star intent");
}

function readSidebarStarState(events, intent, secret, now = Date.now()) {
  assertSidebarStarIntent(intent);
  // The shared bounded decoder verifies signature, own author, schema and budgets.
  decodeSidebarPreferences(events, secret);
  if (
    events.length > 1 ||
    events.some(
      (event) =>
        !event.tags.some(
          ([name, value]) => name === "d" && value === COORDINATE,
        ),
    )
  )
    throw new Error("Invalid sidebar star head");
  const viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const head = events[0];
    const current = head
      ? JSON.parse(nip44.v2.decrypt(head.content, key))
      : { version: 1, channels: {} };
    const previous = Object.hasOwn(current.channels, intent.channelId)
      ? current.channels[intent.channelId]
      : undefined;
    if (previous?.starred === intent.starred || (!previous && !intent.starred))
      return { stars: current, changed: false };
    const stars = {
      ...current,
      channels: {
        ...current.channels,
        [intent.channelId]: {
          ...previous,
          starred: intent.starred,
          updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1),
        },
      },
    };
    return { stars, changed: true, head };
  } finally {
    key.fill(0);
  }
}

/** One explicit star intent against a fresh signed head; keep unstar tombstones. */
export async function prepareSidebarStar(
  events,
  intent,
  secret,
  signer,
  signal,
  now = Date.now(),
) {
  const state = readSidebarStarState(events, intent, secret, now);
  if (!state.changed) return state;
  const viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify(state.stars), key);
  } finally {
    key.fill(0);
  }
  const event = await signer.signEvent(
    {
      kind: 30078,
      content,
      created_at: Math.max(
        Math.floor(now / 1000),
        (state.head?.created_at ?? 0) + 1,
      ),
      tags: [
        ["d", COORDINATE],
        ["t", COORDINATE],
      ],
    },
    signal,
  );
  signal?.throwIfAborted();
  // Refuse over-budget changes rather than silently trimming other channels.
  decodeSidebarPreferences([event], secret);
  return { stars: state.stars, event };
}

export async function mutateSidebarStar(
  intent,
  secret,
  signer,
  signal,
  readHead,
  publish,
) {
  assertSidebarStarIntent(intent);
  const draft = await prepareSidebarStar(
    await readHead(),
    intent,
    secret,
    signer,
    signal,
  );
  signal?.throwIfAborted();
  if (!draft.event) return draft.stars;
  await publish(draft.event);
  const confirmation = readSidebarStarState(await readHead(), intent, secret);
  signal?.throwIfAborted();
  if (confirmation.changed)
    throw new Error(
      "Sidebar stars changed on another device; reload and try again",
    );
  return confirmation.stars;
}
