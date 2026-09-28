import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const out = resolve(process.env.DEMO_OUTPUT ?? "artifacts/native-recovery");
const run = (command, args) =>
  execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
const probe = (file) =>
  JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const stamp = (seconds, delimiter = ".") =>
  new Date(Math.round(seconds * 1000))
    .toISOString()
    .slice(11, 23)
    .replace(".", delimiter);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const reports = [];
try {
  for (const name of (await readdir(out))
    .filter((s) => /^\d\d-.*\.json$/.test(s) && !s.includes("-failed"))
    .sort()) {
    const clip = JSON.parse(await readFile(`${out}/${name}`, "utf8"));
    assert.equal(clip.result, "passed");
    const { id } = clip;
    const source = `${out}/${id}.webm`,
      target = `${out}/${id}.mp4`;
    const trimStart = clip.chapters[0].seconds;
    const chapters = clip.chapters.map((c) => ({
      ...c,
      seconds: c.seconds - trimStart,
    }));
    const duration = Number(probe(source).format.duration) - trimStart;
    assert(duration > 10 && duration < 180);
    // A separate caption band labels the boundary without covering any app pixels.
    await page.setContent('<canvas width="1440" height="80"></canvas>');
    await page.locator("canvas").evaluate((canvas, title) => {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#161a1b";
      ctx.fillRect(0, 0, 1440, 80);
      ctx.fillStyle = "#ffffff";
      ctx.font = "22px Arial";
      ctx.fillText(title.replaceAll("-", " "), 24, 30);
      ctx.font = "18px Arial";
      ctx.fillStyle = "#d7e6e5";
      ctx.fillText(
        "REAL BUZZ UI | Browser fixture: native IPC, signing host and relay mocked | Reload is not native restart",
        24,
        61,
      );
    }, id);
    await page.locator("canvas").screenshot({ path: `${out}/${id}-label.png` });
    const cues = chapters.map((c, i) => ({
      ...c,
      end: chapters[i + 1]?.seconds ?? duration,
    }));
    await writeFile(
      `${out}/${id}.srt`,
      cues
        .map(
          (c, i) =>
            `${i + 1}\n${stamp(c.seconds, ",")} --> ${stamp(c.end, ",")}\n${c.label}\n`,
        )
        .join("\n"),
    );
    await writeFile(
      `${out}/${id}.vtt`,
      `WEBVTT\n\n${cues.map((c) => `${stamp(c.seconds)} --> ${stamp(c.end)}\n${c.label}\n`).join("\n")}`,
    );
    run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      String(trimStart),
      "-i",
      source,
      "-i",
      `${out}/${id}-label.png`,
      "-i",
      `${out}/${id}.srt`,
      "-filter_complex",
      "[0:v]pad=1440:1080:0:0:black[app];[app][1:v]overlay=0:1000[out]",
      "-map",
      "[out]",
      "-map",
      "2:s",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:s",
      "mov_text",
      "-metadata",
      `title=${id} (mocked native IPC and relay)`,
      "-metadata:s:s:0",
      "language=eng",
      "-movflags",
      "+faststart",
      target,
    ]);
    const info = probe(target),
      stream = info.streams.find((s) => s.codec_type === "video");
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.pix_fmt, "yuv420p");
    run("ffmpeg", ["-v", "error", "-i", target, "-f", "null", "-"]);
    const samples = [0, duration / 2, duration - 1];
    const frames = [];
    for (const [i, seconds] of samples.entries()) {
      const path = `${out}/${id}-frame-${i + 1}.png`;
      run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        String(seconds),
        "-i",
        target,
        "-frames:v",
        "1",
        path,
      ]);
      const pixels = run("ffmpeg", [
        "-v",
        "error",
        "-ss",
        String(seconds),
        "-i",
        target,
        "-frames:v",
        "1",
        "-vf",
        "crop=1440:1000:0:0,scale=144:100,format=gray",
        "-f",
        "rawvideo",
        "-",
      ]);
      const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
      const std = Math.sqrt(
        pixels.reduce((a, b) => a + (b - mean) ** 2, 0) / pixels.length,
      );
      assert(std > 5, `${id}: blank app frame at ${seconds}`);
      frames.push({ seconds, std, path });
    }
    reports.push({
      id,
      trimStart,
      duration: Number(info.format.duration),
      codec: stream.codec_name,
      pixelFormat: stream.pix_fmt,
      width: stream.width,
      height: stream.height,
      frames: stream.nb_frames,
      decoded: true,
      sha256: createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
      samples: frames,
      chapters: cues,
    });
    console.log("Encoded and decoded", id, info.format.duration);
  }
  const rows = reports
    .map(
      (r) =>
        `<section id="${r.id}"><h2>${escapeHtml(r.id.replaceAll("-", " "))}</h2><p>${r.duration.toFixed(2)} seconds. Native IPC and relay are mocked. <a href="${r.id}.mp4">MP4</a> | <a href="${r.id}.json">Assertion evidence</a></p><video controls preload="metadata" width="100%" src="${r.id}.mp4"><track default kind="captions" src="${r.id}.vtt" srclang="en" label="Cases"></video><ol>${r.chapters.map((c) => `<li><a href="${r.id}.mp4#t=${c.seconds.toFixed(2)}">${stamp(c.seconds)} - ${stamp(c.end)}</a>: ${escapeHtml(c.label)}</li>`).join("")}</ol></section>`,
    )
    .join("\n");
  await writeFile(
    `${out}/index.html`,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Buzz admission and recovery recordings</title><style>body{font:16px/1.5 system-ui;margin:32px auto;max-width:1200px;padding:0 24px;color:#202627}section{border-top:1px solid #bbb;padding:24px 0}video{background:#111}a{color:#006860}li{margin:8px 0}</style><h1>Buzz admission and recovery recordings</h1><p>Actual Buzz source application at d6f0748e. Playwright Chromium; test identities; no development broker. IPC, Keychain restoration, native signing host, HTTP relay and WSS peer are fixtures. JavaScript adapter, signature verification, app components, localStorage and IndexedDB are real. No real communities or credentials are used.</p><p>Browser reload does not prove a native process restart. Rust NIP-98 authentication, Keychain consent, native persistence and deployed-relay acceptance are not demonstrated. Silent clips preserve the app pixels and add only the boundary caption below them. Timestamps are capture-clock chapter markers; use the visible action and resulting state as the evidence.</p>${rows}</html>`,
  );
  await page.goto(pathToFileURL(`${out}/index.html`).href);
  for (const report of reports) {
    const video = page.locator(`[id="${report.id}"] video`);
    await video.scrollIntoViewIfNeeded();
    await video.evaluate(async (v) => {
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction((id) => {
      const v = document.getElementById(id).querySelector("video");
      return v.currentTime > 0.2 && v.readyState >= 2 && v.videoWidth === 1440;
    }, report.id);
    await video.evaluate((v) => {
      v.pause();
      v.currentTime = v.duration - 0.5;
    });
    await page.waitForFunction((id) => {
      const v = document.getElementById(id).querySelector("video");
      return !v.seeking && v.readyState >= 2 && v.currentTime > v.duration - 1;
    }, report.id);
    report.browserPlayback =
      "loaded, played, advanced, and sought to final frame in Chromium";
  }
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify({ browser: browser.version(), reports }, null, 2),
  );
  await writeFile(
    `${out}/TIMESTAMPS.md`,
    reports
      .map(
        (r) =>
          `## ${r.id}.mp4 (${r.duration.toFixed(2)}s)\n\n${r.chapters.map((c) => `- ${stamp(c.seconds)} - ${stamp(c.end)}: ${c.label}`).join("\n")}\n`,
      )
      .join("\n"),
  );
  console.log(
    `Verified ${reports.length} playable MP4 files: ${out}/index.html`,
  );
} finally {
  await browser.close();
}
