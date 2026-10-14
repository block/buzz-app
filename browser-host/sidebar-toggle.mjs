import {
  editSidebarToggle,
  validSidebarChannelId,
} from "../src/features/relay/sidebar-edits.ts";
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { decodeSidebarPreferences } from "./sidebar-preferences.mjs";

// Only these two fixed host commands exist; never select a coordinate from input.
function sidebarToggle(name, field) {
  const resultKey = `${name}s`;
  const coordinate = `channel-${resultKey}`;
  function assertIntent(intent) {
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      typeof intent.channelId !== "string" ||
      !validSidebarChannelId(intent.channelId) ||
      typeof intent[field] !== "boolean" ||
      Object.keys(intent).some((key) => !["channelId", field].includes(key))
    )
      throw new Error(`Invalid sidebar ${name} intent`);
  }

  /** Apply one explicit toggle to a fresh signed head, preserving tombstones. */
  function prepare(events, intent, secret, now = Date.now()) {
    assertIntent(intent);
    // The shared bounded decoder verifies signature, own author, schema and budgets.
    decodeSidebarPreferences(events, secret);
    if (
      events.length > 1 ||
      events.some(
        (event) =>
          !event.tags.some(
            ([name, value]) => name === "d" && value === coordinate,
          ),
      )
    )
      throw new Error(`Invalid sidebar ${name} head`);
    const viewer = getPublicKey(secret);
    const key = nip44.v2.utils.getConversationKey(secret, viewer);
    try {
      const head = events[0];
      const current = head
        ? JSON.parse(nip44.v2.decrypt(head.content, key))
        : { version: 1, channels: {} };
      const blob = editSidebarToggle(
        current,
        intent.channelId,
        field,
        intent[field],
        now,
      );
      if (blob === current) return { [resultKey]: blob };
      const event = finalizeEvent(
        {
          kind: 30078,
          content: nip44.v2.encrypt(JSON.stringify(blob), key),
          created_at: Math.max(
            Math.floor(now / 1000),
            (head?.created_at ?? 0) + 1,
          ),
          tags: [
            ["d", coordinate],
            ["t", coordinate],
          ],
        },
        secret,
      );
      // Refuse over-budget changes rather than silently trimming other channels.
      decodeSidebarPreferences([event], secret);
      return { [resultKey]: blob, event };
    } finally {
      key.fill(0);
    }
  }

  async function mutate(intent, secret, readHead, publish) {
    assertIntent(intent);
    const draft = prepare(await readHead(), intent, secret);
    if (!draft.event) return draft[resultKey];
    await publish(draft.event);
    const confirmation = prepare(await readHead(), intent, secret);
    if (confirmation.event)
      throw new Error(
        `Sidebar ${resultKey} changed on another device; reload and try again`,
      );
    return confirmation[resultKey];
  }
  return { assertIntent, prepare, mutate };
}

export const {
  assertIntent: assertSidebarStarIntent,
  prepare: prepareSidebarStar,
  mutate: mutateSidebarStar,
} = sidebarToggle("star", "starred");
export const {
  assertIntent: assertSidebarMuteIntent,
  prepare: prepareSidebarMute,
  mutate: mutateSidebarMute,
} = sidebarToggle("mute", "muted");
