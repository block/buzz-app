import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { receiveAttachment } from "./attachment-file.mjs";
import { mediaByteLimit } from "../src/features/relay/attachment-limits.ts";
import { join } from "node:path";
import {
  videoDemuxer,
  isHeic,
  isVoiceNote,
  audioDemuxer,
  VIDEO_PREPARATION_MS,
  ANIMATION_FILTER,
  ANIMATION_MAX,
  ANIMATION_PREPARATION_MS,
} from "../src/features/relay/video-preparation.ts";
import { UploadError, UPLOAD_MAX_BYTES } from "./attachment-upload.mjs";

// Fit the relay's 3840x2160 envelope in either orientation (Retina screen
// recordings exceed it) at even dimensions, never upscale, then pad the odd
// edges of unscaled input for yuv420p.
const VIDEO_FILTER =
  "scale=w='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(iw*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,iw)':h='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(ih*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,ih)',pad=ceil(iw/2)*2:ceil(ih/2)*2";

// Wait for close even after abort: cleanup must not race a still-writing process.
function run(args, signal, timeout = VIDEO_PREPARATION_MS) {
  return new Promise((resolve, reject) => {
    let failure;
    let stdout;
    const child = execFile(
      "ffmpeg",
      args,
      {
        signal,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          LANG: "C",
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
      },
      (error, output) => {
        stdout = output;
        failure ??= error;
      },
    );
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0)
        reject(failure ?? new Error("Conversion failed"));
      else resolve(stdout);
    });
  });
}

/** Development host only: no signing, relay calls, source paths or shell input. */
export async function prepareMedia(req, callerSignal, deliver) {
  // One host-owned deadline covers input, conversion AND a stalled output reader.
  const signal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(VIDEO_PREPARATION_MS),
  ]);
  const spool = await receiveAttachment(
    req,
    UPLOAD_MAX_BYTES,
    signal,
    () => new UploadError("size", 413),
  );
  try {
    signal.throwIfAborted();
    const name = req.headers["x-attachment-name"]
      ? decodeURIComponent(req.headers["x-attachment-name"])
      : "";
    const animation = req.headers["x-buzz-preparation"] === "animation";
    const voice = !animation && isVoiceNote(name);
    const heic = !animation && !voice && isHeic(spool.header, name);
    if (voice && spool.size > 128 * 1024 * 1024)
      throw new UploadError("size", 413);
    const demuxer = voice
      ? audioDemuxer(spool.header)
      : heic
        ? "mov"
        : videoDemuxer(spool.header);
    if (!demuxer) throw new UploadError("video");
    // An animated avatar is a VP9-alpha WebM; the client strips the APNG's pHYs.
    if (animation && demuxer !== "matroska") throw new UploadError("video");
    if (animation && spool.size > 64 * 1024 * 1024)
      throw new UploadError("size", 413);
    const type = heic ? "image/jpeg" : animation ? "image/png" : "video/mp4";
    const limit = animation ? ANIMATION_MAX : mediaByteLimit(type);
    const source = spool.path;
    const output = join(
      spool.directory,
      heic ? "prepared.jpg" : animation ? "prepared.png" : "prepared.mp4",
    );
    // Fixed demuxers prevent playlist inputs; MOV external data references are disabled.
    const input =
      demuxer === "mov"
        ? ["-enable_drefs", "0", "-use_absolute_path", "0"]
        : [];
    let outputLimitExceeded = false;
    const conversion = new AbortController();
    const bounded = AbortSignal.any([signal, conversion.signal]);
    // Do not use ffmpeg -fs: it can exit successfully with a truncated clip.
    const monitor = setInterval(() => {
      void stat(output)
        .then((value) => {
          if (value.size > limit) {
            outputLimitExceeded = true;
            conversion.abort();
          }
        })
        .catch(() => {}); // Output need not exist yet; process completion is authoritative.
    }, 250);
    try {
      if (heic) {
        const version = await run(["-version"], bounded, 5_000);
        const major = /^ffmpeg version n?(\d+)\./.exec(version ?? "")?.[1];
        if (!major || Number(major) < 8) throw new UploadError("ffmpeg", 503);
      }
      await run(
        [
          "-y",
          "-nostdin",
          "-loglevel",
          "error",
          ...(voice ? ["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1"] : []),
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          demuxer,
          ...input,
          // Only libvpx reads the WebM's alpha; the built-in vp9 decoder drops it.
          ...(animation ? ["-c:v", "libvpx-vp9"] : []),
          "-i",
          source,
          ...(heic
            ? [
                // Automatic selection assembles HEIC grids, not the first tile.
                "-map_metadata",
                "-1",
                "-frames:v",
                "1",
                "-fflags",
                "+bitexact",
                "-flags:v",
                "+bitexact",
                "-q:v",
                "2",
              ]
            : animation
              ? [
                  "-map",
                  "0:v:0",
                  "-an",
                  "-sn",
                  "-dn",
                  "-map_metadata",
                  "-1",
                  "-map_chapters",
                  "-1",
                  "-fflags",
                  "+bitexact",
                  "-flags:v",
                  "+bitexact",
                  "-t",
                  "10",
                  "-vf",
                  ANIMATION_FILTER,
                  "-c:v",
                  "apng",
                  "-plays",
                  "0",
                  "-pred",
                  "mixed",
                  "-f",
                  "apng",
                ]
              : [
                  "-map",
                  "0:v:0",
                  "-map",
                  voice ? "1:a:0" : "0:a:0?",
                  ...(voice ? ["-shortest"] : []),
                  "-map_metadata",
                  "-1",
                  "-map_chapters",
                  "-1",
                  "-sn",
                  "-dn",
                  "-fflags",
                  "+bitexact",
                  "-flags:v",
                  "+bitexact",
                  "-flags:a",
                  "+bitexact",
                  "-c:v",
                  "libx264",
                  "-preset",
                  "fast",
                  "-crf",
                  "23",
                  "-pix_fmt",
                  "yuv420p",
                  "-vf",
                  VIDEO_FILTER,
                  "-c:a",
                  "aac",
                  "-b:a",
                  "128k",
                  "-movflags",
                  "+faststart",
                  "-metadata",
                  "encoder=",
                ]),
          output,
        ],
        bounded,
        heic
          ? 60_000
          : animation
            ? ANIMATION_PREPARATION_MS
            : VIDEO_PREPARATION_MS,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (outputLimitExceeded) throw new UploadError("size", 413);
      if (error instanceof UploadError) throw error;
      throw new UploadError(
        error.code === "ENOENT" ? "ffmpeg" : heic ? "image" : "video",
        error.code === "ENOENT" ? 503 : 400,
      );
    } finally {
      clearInterval(monitor);
    }
    signal.throwIfAborted();
    if (outputLimitExceeded) throw new UploadError("size", 413);
    const prepared = await stat(output);
    if (!prepared.size || prepared.size > limit)
      throw new UploadError("size", 413);
    // The route awaits transfer completion before this request releases its temp files.
    return await deliver(output, type, prepared.size, signal);
  } finally {
    await spool.cleanup();
  }
}
