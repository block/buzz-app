import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** One request owns a private spool; cleanup includes receive/write failure. */
export async function receiveAttachment(req, limit, signal, sizeError) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-attachment-"));
  const path = join(directory, "source");
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let size = 0;
  const hash = createHash("sha256");
  try {
    signal.throwIfAborted();
    if (Number(req.headers["content-length"]) > limit) throw sizeError();
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(sizeError());
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    // Do not pipeline the HTTP request itself: size rejection must still send a 413.
    async function* source() {
      const iterator = req.iterator({ destroyOnReturn: false });
      for await (const chunk of iterator) yield chunk;
    }
    const abort = () => req.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await pipeline(
        source(),
        meter,
        createWriteStream(path, { mode: 0o600, flags: "wx" }),
        { signal },
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (!size) throw sizeError();
    const file = await open(path, "r");
    let header;
    try {
      const buffer = Buffer.alloc(Math.min(size, 4096));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    return {
      path,
      directory,
      size,
      header,
      sha256: hash.digest("hex"),
      cleanup,
    };
  } catch (error) {
    if (signal.aborted) req.destroy();
    await cleanup();
    throw error;
  }
}
