import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools";
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_TIMEOUT_MS,
  UploadError,
  validateUploadResult,
} from "../src/features/relay/attachments.ts";

/** Bounded binary body, not JSON/base64 file data. Server owns content validation. */
export async function uploadAttachment(req, relay, key, fetchUpstream, signal) {
  const contentType = req.headers["content-type"] || "application/octet-stream";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType))
    throw new UploadError("rejected");
  const length = Number(req.headers["content-length"]);
  if (length > UPLOAD_MAX_BYTES) throw new UploadError("size");
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  ]);
  const abort = () => req.destroy();
  bounded.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let size = 0;
  const hash = createHash("sha256");
  try {
    bounded.throwIfAborted();
    for await (const chunk of req) {
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) throw new UploadError("size");
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (!size) throw new UploadError("size");
    const sha256 = hash.digest("hex");
    bounded.throwIfAborted();
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: 24242,
        created_at: now,
        content: "Upload attachment",
        tags: [
          ["t", "upload"],
          ["x", sha256],
          ["server", new URL(relay).host],
          ["expiration", String(now + 300)],
        ],
      },
      key,
    );
    const response = await fetchUpstream(`${relay}/upload`, {
      method: "PUT",
      redirect: "error",
      signal: bounded,
      headers: {
        "Content-Type": contentType,
        "X-SHA-256": sha256,
        Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`,
      },
      body: Buffer.concat(chunks, size),
    });
    let text = "";
    if (response.body)
      for await (const chunk of response.body) {
        text += Buffer.from(chunk).toString("utf8");
        if (text.length > 8192) throw new UploadError("invalid");
      }
    if (!response.ok) {
      if ([400, 415, 422].includes(response.status) && /metadata/i.test(text))
        throw new UploadError("metadata");
      throw new UploadError(
        response.status === 413
          ? "size"
          : response.status === 429
            ? "capacity"
            : [401, 403].includes(response.status)
              ? "denied"
              : [400, 415, 422].includes(response.status)
                ? "rejected"
                : "failed",
      );
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new UploadError("invalid");
    }
    return validateUploadResult(value, relay, size, sha256);
  } finally {
    bounded.removeEventListener("abort", abort);
  }
}
