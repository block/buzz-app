import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { attachmentMessage, type UploadedAttachment } from "./attachments";
import { imageType } from "./attachment-limits";
import { prepareAttachment } from "../messages/prepare-attachment";
import { cleanPng } from "../messages/image-metadata";

/** Only upload supported still images. Relay metadata checks reject unsafe containers. */
export async function feedbackImage(
  file: File,
  signal: AbortSignal,
): Promise<File> {
  if (!file.size || file.size > 50 * 1024 * 1024)
    throw new Error("Feedback image exceeds the supported size.");
  const kind = imageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (
    !kind ||
    kind !== file.type ||
    (kind === "image/gif" && file.size > 10 * 1024 * 1024)
  )
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
  // The message preparation pipeline preserves Buzz snapshot manifests. Feedback
  // must not carry that private editor state into the operator inbox.
  const prepared = await prepareAttachment(file, signal);
  if (prepared.type !== "image/png") return prepared;
  const bytes = new Uint8Array(await prepared.arrayBuffer());
  signal.throwIfAborted();
  return new File([cleanPng(bytes)], prepared.name, {
    type: "image/png",
    lastModified: prepared.lastModified,
  });
}

export async function feedbackDiagnostics(now = new Date()): Promise<File> {
  let version = "unknown";
  if (isTauri()) {
    try {
      version = await getVersion();
    } catch {
      // Version is optional; never block feedback on native metadata.
    }
  }
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const content = [
    "Buzz feedback diagnostics",
    `captured: ${now.toISOString()}`,
    `app version: ${version}`,
    `platform: ${nav?.platform ?? "unknown"}`,
    `user agent: ${nav?.userAgent ?? "unknown"}`,
    `language: ${nav?.language ?? "unknown"}`,
  ].join("\n");
  return new File([content], "feedback-diagnostics.txt", {
    type: "text/plain",
  });
}

/** Private deployment inbox protocol. No channel tag, event view, or NIP-56 report. */
export const PRODUCT_FEEDBACK_KIND = 42000;
export type FeedbackCategory = "bug" | "praise" | "needs-work";

export function feedbackEvent(
  message: string,
  category: FeedbackCategory | null,
  attachments: readonly UploadedAttachment[] = [],
  origin?: string,
) {
  const payload = attachments.length
    ? attachmentMessage(message, attachments, origin)
    : { content: message.trim(), tags: [] as string[][] };
  const { content } = payload;
  const tags = [...(category ? [["category", category]] : []), ...payload.tags];
  const input = {
    kind: PRODUCT_FEEDBACK_KIND,
    content,
    tags,
  };
  if (
    !message.trim() ||
    !content ||
    byteSize(input) > OUTBOX_INPUT_MAX_BYTES ||
    new TextEncoder().encode(JSON.stringify(tags)).length > 64 * 1024
  )
    throw new Error("Feedback must contain text and fit within relay limits.");
  return input;
}
