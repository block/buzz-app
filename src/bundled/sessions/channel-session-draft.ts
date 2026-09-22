import {
  mentionDraft,
  type MentionDraft,
} from "../../features/messages/mention-draft";
import type { EventData } from "../../features/relay/events";
import { isQuietSessionRoot } from "../../features/relay/channel-session";
import type { DraftIdentity } from "../../features/relay/outbox";

export type ChannelSessionDraft = DraftIdentity &
  Readonly<{
    draft: MentionDraft;
    messageId?: string;
  }>;
export const channelSessionDraftKey = (channelId: string) =>
  `channel-session:${channelId}:draft`;
const key = (scope: string, channelId: string) =>
  `buzz-channel-session.v1:${JSON.stringify([scope, channelId])}`;

const editorGenerationKey = (
  scope: string,
  channelId: string,
  viewer: string | undefined,
) =>
  `buzz-channel-session-editor.v1:${JSON.stringify([scope, channelId, viewer])}`;

/** Capture before mounting the editor; allocation and all writes require its lock. */
export function readChannelSessionEditorGeneration(
  scope: string,
  channelId: string,
  viewer: string | undefined,
): number {
  const raw = localStorage.getItem(
    editorGenerationKey(scope, channelId, viewer),
  );
  if (raw === null) return 0;
  const generation: unknown = JSON.parse(raw);
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation >= Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      "The saved session editor generation is invalid. Nothing was sent.",
    );
  return generation;
}
export function saveChannelSessionEditorGeneration(
  scope: string,
  channelId: string,
  viewer: string | undefined,
  generation: number,
) {
  localStorage.setItem(
    editorGenerationKey(scope, channelId, viewer),
    JSON.stringify(generation),
  );
}

/** The browser arbitrates all creation-record mutations across windows. */
export async function withChannelSessionDraftLock<T>(
  scope: string,
  channelId: string,
  viewer: string | undefined,
  work: () => T,
): Promise<T> {
  if (!viewer || typeof navigator === "undefined" || !navigator.locks)
    throw new Error(
      "Safe session creation requires browser Web Locks. Nothing was sent.",
    );
  return navigator.locks.request(
    `buzz-channel-session:${JSON.stringify([scope, channelId, viewer])}`,
    { mode: "exclusive" },
    work,
  );
}

/** A single scoped creation record, not a delivery journal. Storage errors must surface. */
export function readChannelSessionDraft(
  scope: string,
  channelId: string,
): ChannelSessionDraft | undefined {
  const raw = localStorage.getItem(key(scope, channelId));
  if (raw === null) return;
  const value = JSON.parse(raw) as ChannelSessionDraft;
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.draft?.text !== "string" ||
    value.draft.text.length > 16000 ||
    !value.draft.text.trim() ||
    !mentionDraft(value.draft).recipients.length ||
    JSON.stringify(mentionDraft(value.draft)) !== JSON.stringify(value.draft) ||
    (value.messageId !== undefined && !/^[0-9a-f]{64}$/.test(value.messageId))
  )
    throw new Error(
      "The saved session draft is invalid. It has not been resent.",
    );
  return value;
}
export function saveChannelSessionDraft(
  scope: string,
  channelId: string,
  value: ChannelSessionDraft,
) {
  localStorage.setItem(key(scope, channelId), JSON.stringify(value));
}
export function clearChannelSessionDraft(
  scope: string,
  channelId: string,
  viewer: string | undefined,
) {
  const generation = readChannelSessionEditorGeneration(
    scope,
    channelId,
    viewer,
  );
  // Clear editor before advancing its generation so a new opening cannot bind old
  // durable input to the new generation. Any failure retains the creation record.
  localStorage.removeItem(
    `buzz-view.v1:${JSON.stringify([scope, channelSessionDraftKey(channelId)])}`,
  );
  saveChannelSessionEditorGeneration(scope, channelId, viewer, generation + 1);
  localStorage.removeItem(key(scope, channelId));
}

/** An exact draft ID is a correlation key, never permission or admission evidence. */
export function matchesChannelSessionDraft(
  event: EventData,
  saved: ChannelSessionDraft,
  channelId: string,
  viewer: string | undefined,
) {
  if (
    !isQuietSessionRoot(event) ||
    event.pubkey !== viewer ||
    event.created_at !== saved.createdAt ||
    event.content !== saved.draft.text.trim() ||
    !event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId) ||
    event.tags.filter((tag) => tag[0] === "client-id").length !== 1 ||
    !event.tags.some(
      (tag) =>
        tag.length === 2 && tag[0] === "client-id" && tag[1] === saved.id,
    ) ||
    (saved.messageId && saved.messageId !== event.id)
  )
    return false;
  const expected = [
    ...new Set(saved.draft.recipients.map((item) => item.pubkey)),
  ].sort();
  const actual = [
    ...new Set(event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1])),
  ].sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}
