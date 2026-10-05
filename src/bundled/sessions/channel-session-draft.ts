import {
  sessionCommandDraft,
  sessionCommandContent,
} from "../../features/sessions/session-command";
import {
  mentionDraft,
  type MentionDraft,
} from "../../features/messages/mention-draft";
import type { EventData } from "../../features/relay/events";
import {
  sessionRootPresentation,
  type SessionPresentation,
} from "../../features/relay/channel-session";
import type { DraftIdentity } from "../../features/relay/outbox";

export type ChannelSessionDraft = DraftIdentity &
  Readonly<{
    draft: MentionDraft;
    messageId?: string;
    presentation?: SessionPresentation;
    rawDraft?: MentionDraft;
    content?: string;
    generation?: number;
    viewer?: string;
    channelId?: string;
    scope?: string;
    accepted?: boolean;
  }>;
export const channelSessionDraftKey = (channelId: string) =>
  `channel-session:${channelId}:draft`;
type Namespace = "draft" | "command";
const key = (scope: string, channelId: string, namespace: Namespace) =>
  `buzz-channel-session${namespace === "command" ? "-command" : ""}.v1:${JSON.stringify([scope, channelId])}`;

const editorGenerationKey = (
  scope: string,
  channelId: string,
  viewer: string | undefined,
  namespace: Namespace,
) =>
  `buzz-channel-session${namespace === "command" ? "-command" : ""}-editor.v1:${JSON.stringify([scope, channelId, viewer])}`;

/** Capture before mounting the editor; allocation and all writes require its lock. */
export function readChannelSessionEditorGeneration(
  scope: string,
  channelId: string,
  viewer: string | undefined,
  namespace: Namespace = "draft",
): number {
  const raw = localStorage.getItem(
    editorGenerationKey(scope, channelId, viewer, namespace),
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
  namespace: Namespace = "draft",
) {
  localStorage.setItem(
    editorGenerationKey(scope, channelId, viewer, namespace),
    JSON.stringify(generation),
  );
}

/** The browser arbitrates all creation-record mutations across windows. */
export async function withChannelSessionDraftLock<T>(
  scope: string,
  channelId: string,
  viewer: string | undefined,
  work: () => T,
  namespace: Namespace = "draft",
): Promise<T> {
  if (!viewer || typeof navigator === "undefined" || !navigator.locks)
    throw new Error(
      "Safe session creation requires browser Web Locks. Nothing was sent.",
    );
  return navigator.locks.request(
    `buzz-channel-session${namespace === "command" ? "-command" : ""}:${JSON.stringify([scope, channelId, viewer])}`,
    { mode: "exclusive" },
    work,
  );
}

/** A single scoped creation record, not a delivery journal. Storage errors must surface. */
export function readChannelSessionDraft(
  scope: string,
  channelId: string,
  namespace: Namespace = "draft",
): ChannelSessionDraft | undefined {
  const raw = localStorage.getItem(key(scope, channelId, namespace));
  if (raw === null) return;
  return validateChannelSessionDraft(
    JSON.parse(raw),
    scope,
    channelId,
    namespace,
  );
}
// JSON object member order is not part of a saved draft's payload.
const payload = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
function validateChannelSessionDraft(
  value: ChannelSessionDraft,
  scope: string,
  channelId: string,
  namespace: Namespace,
) {
  if (
    !value ||
    (namespace === "draft" &&
      ((value.presentation !== undefined && value.presentation !== "quiet") ||
        value.rawDraft !== undefined ||
        value.content !== undefined ||
        value.generation !== undefined ||
        value.viewer !== undefined ||
        value.channelId !== undefined ||
        value.scope !== undefined ||
        value.accepted !== undefined)) ||
    (namespace === "command" &&
      (value.presentation !== "chip" ||
        typeof value.rawDraft?.text !== "string" ||
        (value.content !== undefined &&
          value.content !== sessionCommandContent(value.rawDraft)) ||
        value.rawDraft.text.length > 16000 ||
        payload(sessionCommandDraft(value.rawDraft)) !== payload(value.draft) ||
        payload(mentionDraft(value.rawDraft)) !== payload(value.rawDraft) ||
        !Number.isSafeInteger(value.generation) ||
        (value.generation ?? -1) < 0 ||
        (value.generation ?? 0) >= Number.MAX_SAFE_INTEGER ||
        value.scope !== scope ||
        (value.accepted !== undefined &&
          (value.accepted !== true || !value.messageId)) ||
        !/^[0-9a-f]{64}$/.test(value.viewer ?? "") ||
        value.channelId !== channelId)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.draft?.text !== "string" ||
    value.draft.text.length > 16000 ||
    !value.draft.text.trim() ||
    !mentionDraft(value.draft).recipients.length ||
    payload(mentionDraft(value.draft)) !== payload(value.draft) ||
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
  namespace: Namespace = "draft",
) {
  validateChannelSessionDraft(value, scope, channelId, namespace);
  localStorage.setItem(key(scope, channelId, namespace), JSON.stringify(value));
}
export function clearChannelSessionDraft(
  scope: string,
  channelId: string,
  viewer: string | undefined,
  namespace: Namespace = "draft",
) {
  const generation = readChannelSessionEditorGeneration(
    scope,
    channelId,
    viewer,
    namespace,
  );
  // Clear editor before advancing its generation so a new opening cannot bind old
  // durable input to the new generation. Any failure retains the creation record.
  if (namespace === "draft")
    localStorage.removeItem(
      `buzz-view.v1:${JSON.stringify([scope, channelSessionDraftKey(channelId)])}`,
    );
  saveChannelSessionEditorGeneration(
    scope,
    channelId,
    viewer,
    generation + 1,
    namespace,
  );
  localStorage.removeItem(key(scope, channelId, namespace));
  return generation + 1;
}

/** An exact draft ID is a correlation key, never permission or admission evidence. */
export function matchesChannelSessionDraft(
  event: EventData,
  saved: ChannelSessionDraft,
  channelId: string,
  viewer: string | undefined,
) {
  if (
    sessionRootPresentation(event) !== (saved.presentation ?? "quiet") ||
    event.pubkey !== viewer ||
    event.created_at !== saved.createdAt ||
    event.content !== (saved.content ?? saved.draft.text).trim() ||
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
