#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length > 0) {
  console.error(
    "Usage: bin/node scripts/export-claude-session.mjs <session.jsonl> <output.html>",
  );
  process.exit(1);
}

// Transcripts are untrusted text: never interpret their Markdown, HTML, or URLs.
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const text = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const pre = (value) => `<pre>${escapeHtml(text(value))}</pre>`;
const details = (label, value) =>
  `<details><summary>${escapeHtml(label)}</summary>${pre(value)}</details>`;

function renderBlock(block) {
  switch (block.type) {
    case "text":
      return pre(block.text);
    case "thinking":
      return details("Thinking", block.thinking || "Not recorded");
    case "tool_use":
      return details(`Tool: ${block.name} · ${block.id}`, block.input);
    case "tool_result":
      return details(
        `Tool result${block.is_error ? " · error" : ""} · ${block.tool_use_id}`,
        block.content,
      );
    default:
      return details(`Content: ${block.type || "unknown"}`, block);
  }
}

try {
  const records = readFileSync(source, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        throw new Error(`Invalid JSON on line ${index + 1}; no export written`);
      }
    });
  const messages = records.filter((entry) => entry?.message != null);
  if (messages.length === 0) throw new Error("No recorded messages to export");
  const first = messages[0];
  const models = [
    ...new Set(messages.map((entry) => entry.message.model).filter(Boolean)),
  ];
  const cards = messages.map((entry) => {
    const content = entry.message.content;
    const body = Array.isArray(content)
      ? content.map(renderBlock).join("\n")
      : pre(content);
    return `<article><header><strong>${escapeHtml(entry.type)}</strong>
      <span>${escapeHtml(entry.timestamp)}</span></header>${body}</article>`;
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Claude session ${escapeHtml(first.sessionId)}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 1000px; margin: 32px auto; padding: 0 20px; line-height: 1.5; }
h1 { margin-bottom: 8px; }
.metadata { overflow-wrap: anywhere; margin-bottom: 28px; }
article { border: 1px solid GrayText; border-radius: 10px; padding: 16px; margin: 16px 0; }
header { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
header span { color: GrayText; font-size: 0.85em; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9em; line-height: 1.6; }
details { border-top: 1px solid GrayText; padding: 10px 0; }
summary { cursor: pointer; overflow-wrap: anywhere; }
</style></head><body>
<h1>Claude Code session</h1>
<div class="metadata">Session: ${escapeHtml(first.sessionId)}<br>
Working directory: ${escapeHtml(first.cwd)}<br>Models: ${escapeHtml(models.join(", "))}<br>
${messages.length} recorded messages · local snapshot<br>
Transcript: ${escapeHtml(resolve(source))}</div>
${cards.join("\n")}
</body></html>`;
  // Never overwrite a transcript or an existing export; keep private data local.
  writeFileSync(destination, html, { flag: "wx", mode: 0o600 });
  console.log(
    `Exported ${messages.length} messages to ${resolve(destination)}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
