import { safeAttachmentName } from "./message-content";

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 120_000;
export type UploadedAttachment = Readonly<{
  name: string;
  url: string;
  type: string;
  size: number;
  sha256: string;
}>;
export type AttachmentUpload = (
  file: File,
  signal: AbortSignal,
) => Promise<UploadedAttachment>;
export const UPLOAD_FAILURES = {
  unavailable: "Uploads are unavailable on this connection.",
  size: "Choose a file between 1 byte and 20 MB.",
  capacity: "Uploads are busy. Retry this file shortly.",
  metadata:
    "This file needs metadata cleanup before it can be uploaded. Choose an exported copy without metadata, or remove it for now.",
  rejected:
    "The server could not accept this file. Its format or metadata may not be supported.",
  denied: "You don’t have permission to upload here.",
  failed: "Upload did not finish. Retry or remove this file.",
  invalid: "The server returned an invalid upload result. Retry this file.",
  cancelled: "Upload cancelled. Retry to upload this file.",
} as const;
export type UploadCode = keyof typeof UPLOAD_FAILURES;
export class UploadError extends Error {
  constructor(readonly code: UploadCode) {
    super(UPLOAD_FAILURES[code]);
  }
}
export function validateUploadResult(
  value: unknown,
  origin: string,
  size: number,
  name: string,
): UploadedAttachment {
  const v = value as Partial<UploadedAttachment> | null;
  if (
    !v ||
    typeof v.url !== "string" ||
    typeof v.type !== "string" ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(v.type) ||
    v.size !== size ||
    typeof v.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > UPLOAD_MAX_BYTES
  )
    throw new UploadError("invalid");
  let url: URL;
  try {
    url = new URL(v.url, origin);
  } catch {
    throw new UploadError("invalid");
  }
  if (
    url.origin !== new URL(origin).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/media/${v.sha256}(?:\\.[a-z0-9]{1,8})?$`).test(url.pathname)
  )
    throw new UploadError("invalid");
  return Object.freeze({
    name,
    url: url.href,
    type: v.type.toLowerCase(),
    size,
    sha256: v.sha256,
  });
}
function attachmentMarkdown(name: string, result: UploadedAttachment) {
  const label = Array.from(name, (char) =>
    char.charCodeAt(0) < 32 ? " " : char,
  )
    .join("")
    .replace(/[\\`*_{}[\]()!<>]/g, "\\$&");
  const image = /^(image\/(png|jpeg|gif|webp)|video\/mp4)$/.test(result.type);
  return `${image ? "!" : ""}[${label}](<${result.url}>)`;
}
export function brokerUpload(
  endpoint: string,
  origin: string,
): AttachmentUpload {
  return async (file, signal) => {
    signal.throwIfAborted();
    if (!file.size || file.size > UPLOAD_MAX_BYTES)
      throw new UploadError("size");
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    ]);
    const response = await fetch(`${endpoint}/upload`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      signal: bounded,
    });
    if ([401, 403, 413, 429].includes(response.status)) {
      try {
        await response.body?.cancel();
      } catch {
        /* Keep the known failure. */
      }
      throw new UploadError(
        response.status === 413
          ? "size"
          : response.status === 429
            ? "capacity"
            : "denied",
      );
    }
    let text = "";
    const reader = response.body?.getReader();
    if (!reader) throw new UploadError("invalid");
    try {
      const decoder = new TextDecoder();
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) throw new UploadError("invalid");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* Do not replace a parsing failure. */
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UploadError("invalid");
    }
    if (!response.ok) {
      const code = (body as { code?: string })?.code;
      throw new UploadError(
        code && Object.hasOwn(UPLOAD_FAILURES, code)
          ? (code as UploadCode)
          : "failed",
      );
    }
    bounded.throwIfAborted();
    return validateUploadResult(body, origin, file.size, file.name);
  };
}

/** Only completed uploads enter the existing message/outbox contract. */
export function attachmentMessage(
  content: string,
  attachments: readonly UploadedAttachment[],
  origin?: string,
) {
  const tags: string[][] = [];
  const links = attachments.map((item) => {
    if (!origin || typeof item.name !== "string")
      throw new UploadError("invalid");
    const result = validateUploadResult(item, origin, item.size, item.name);
    // Relay filename metadata is a basename capped at 255 UTF-8 bytes.
    let name = "";
    let bytes = 0;
    for (const char of item.name) {
      const clean =
        !safeAttachmentName(char) || char === "/" || char === "\\" ? " " : char;
      bytes += new TextEncoder().encode(clean).length;
      if (bytes > 255) break;
      name += clean;
    }
    name = name.trim() || "File";
    tags.push([
      "imeta",
      `url ${result.url}`,
      `m ${result.type}`,
      `size ${result.size}`,
      `x ${result.sha256}`,
      `filename ${name}`,
    ]);
    return attachmentMarkdown(name, result);
  });
  return {
    content: [content.trim(), ...links].filter(Boolean).join("\n\n"),
    tags,
  };
}
