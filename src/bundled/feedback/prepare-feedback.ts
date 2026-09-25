import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { imageType } from "../../features/relay/attachment-limits";
import { prepareAttachment } from "../../features/messages/prepare-attachment";
import { cleanPng } from "../../features/messages/image-metadata";

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
