#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length > 0) {
  console.error(
    "Usage: bin/node scripts/export-codex-session.mjs <rollout.jsonl> <output.html>",
  );
  process.exit(1);
}

// Rollouts are untrusted text: never interpret their Markdown, HTML, or URLs.
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
const time = (timestamp) =>
  `<div class="time">${escapeHtml(timestamp?.slice(11, 19))}</div>`;
// Long text shows a preview; clicking toggles the full text, as in Pi's viewer.
function expandable(value, lines = 10) {
  const all = text(value).split("\n");
  if (all.length <= lines) return `<pre>${escapeHtml(all.join("\n"))}</pre>`;
  return `<div class="expandable"><pre class="preview">${escapeHtml(all.slice(0, lines).join("\n"))}</pre><div class="hint preview">… (${all.length - lines} more lines, click to expand)</div><pre class="full">${escapeHtml(all.join("\n"))}</pre></div>`;
}
const contentText = (content) =>
  (content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
// Tool outputs are a string or a list of text/image content items.
const outputText = (output) =>
  Array.isArray(output) &&
  output.every((item) => typeof item?.text === "string")
    ? output.map((item) => item.text).join("\n")
    : output;
// Codex injects AGENTS.md and environment context as user-role messages.
const isContext = (value) =>
  /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>)/.test(
    value,
  );
// Buzz turns end with `Request: "<json string>"`; show that instead of context.
function buzzRequest(value) {
  const match = value.match(/^Request: (".*")$/m);
  try {
    return match ? JSON.parse(match[1]) : undefined;
  } catch {
    return undefined;
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
  const meta =
    records.find((entry) => entry?.type === "session_meta")?.payload ?? {};
  const outputs = new Map(
    records
      .filter((entry) => entry?.payload?.type?.endsWith?.("_output"))
      .map((entry) => [entry.payload.call_id, entry.payload]),
  );
  // Each entry: kind (filter group), label, preview (sidebar), html (card).
  const entries = [];
  let model;
  for (const { timestamp, type, payload: item } of records) {
    if (type === "turn_context" && item?.model && item.model !== model) {
      model = item.model;
      const label = `${model}${item.effort ? ` · ${item.effort}` : ""}`;
      entries.push({
        kind: "model",
        label: "model",
        preview: label,
        html: `<div class="model">${time(timestamp)}Switched to model: <span class="accent">${escapeHtml(label)}</span></div>`,
      });
    }
    if (type !== "response_item" || !item?.type) continue;
    if (item.type === "message") {
      const body = contentText(item.content);
      if (!body) continue;
      if (item.role === "developer" || isContext(body)) {
        const label = item.role === "developer" ? "instructions" : "context";
        entries.push({
          kind: "instructions",
          label,
          preview: body,
          html: `<div class="card instructions">${time(timestamp)}<div class="title">${label}</div>${expandable(body, 2)}</div>`,
        });
      } else if (item.role === "user") {
        const request = buzzRequest(body);
        entries.push({
          kind: "user",
          label: "user",
          preview: request ?? body,
          html: `<div class="card user">${time(timestamp)}${request === undefined ? expandable(body, 20) : `<pre>${escapeHtml(request)}</pre><div class="title muted">Buzz turn</div>${expandable(body, 0)}`}</div>`,
        });
      } else {
        entries.push({
          kind: "assistant",
          label: "assistant",
          preview: body,
          html: `<div class="assistant">${time(timestamp)}<pre>${escapeHtml(body)}</pre></div>`,
        });
      }
    } else if (item.type === "reasoning") {
      const summary = (item.summary ?? []).map((part) => part.text).join("\n");
      if (summary)
        entries.push({
          kind: "assistant",
          label: "thinking",
          preview: summary,
          html: `<div class="assistant thinking">${time(timestamp)}<pre>${escapeHtml(summary)}</pre></div>`,
        });
    } else if (item.call_id && !item.type.endsWith("_output")) {
      const input = item.input ?? item.arguments ?? item.action ?? "";
      // Code Mode runs nested tools from an `exec` script; name them.
      const nested = [
        ...new Set(
          [...text(input).matchAll(/tools\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
        ),
      ];
      const name = item.name || item.type;
      const output = outputs.get(item.call_id);
      entries.push({
        kind: "tool",
        label: name,
        preview: nested.join(", ") || text(input),
        html: `<div class="card tool ${output ? "done" : "pending"}">${time(timestamp)}<div class="title">${escapeHtml(name)} <span class="accent">${escapeHtml(nested.join(", "))}</span></div>${expandable(input, 20)}${output ? `<div class="output">${expandable(outputText(output.output))}</div>` : ""}</div>`,
      });
    } else if (!item.type.endsWith("_output")) {
      const { encrypted_content: _, ...rest } = item;
      entries.push({
        kind: "other",
        label: item.type,
        preview: text(rest),
        html: `<div class="card">${time(timestamp)}<div class="title">${escapeHtml(item.type)}</div>${expandable(rest)}</div>`,
      });
    }
  }
  if (entries.length === 0) throw new Error("No recorded items to export");
  const count = (kind) => entries.filter((entry) => entry.kind === kind).length;
  const nonce = randomBytes(16).toString("base64");
  const nav = entries
    .map(
      (entry, index) =>
        `<div class="node" data-kind="${entry.kind}" data-target="e${index}"><span class="role role-${entry.kind}">${escapeHtml(entry.label)}:</span> ${escapeHtml(entry.preview.replace(/\s+/g, " ").slice(0, 200))}</div>`,
    )
    .join("\n");
  const cards = entries
    .map(
      (entry, index) =>
        `<section id="e${index}" data-kind="${entry.kind}">${entry.html}</section>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Codex session ${escapeHtml(meta.id)}</title>
<style>
:root { --bg: #1c1a22; --panel: #232129; --text: #e2e3e6; --muted: #a2a5ae; --dim: #6f7380;
  --accent: #8fd3e0; --success: #7bd6a8; --user: #2b3050; --tool: #213a30; --pending: #33343a; --custom: #3d2a45; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font: 12px/18px ui-monospace, Menlo, Consolas, monospace; color: var(--text); background: var(--bg); display: flex; }
aside { width: 380px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--dim); }
.controls { padding: 12px; display: flex; flex-wrap: wrap; gap: 4px; }
input { width: 100%; margin-bottom: 4px; padding: 4px 8px; font: inherit; font-size: 11px; color: var(--text); background: var(--bg); border: 1px solid var(--dim); border-radius: 3px; }
button { padding: 2px 8px; font: inherit; font-size: 10px; color: var(--muted); background: none; border: 1px solid var(--dim); border-radius: 3px; cursor: pointer; }
button.active { color: var(--bg); background: var(--accent); border-color: var(--accent); }
nav { overflow-y: auto; padding-bottom: 12px; }
.node { display: block; padding: 1px 12px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.node:hover, .node.active { background: var(--user); }
.role { color: var(--muted); } .role-user { color: var(--accent); font-weight: bold; } .role-assistant { color: var(--success); }
main { flex: 1; min-width: 0; padding: 18px 36px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
main > * { width: 100%; max-width: 800px; }
.header { background: var(--panel); border-radius: 4px; padding: 18px; color: var(--muted); overflow-wrap: anywhere; }
h1 { font-size: 12px; color: var(--accent); margin-bottom: 12px; }
.card { padding: 18px; border-radius: 4px; background: var(--panel); }
.user { background: var(--user); } .tool.done { background: var(--tool); } .tool.pending { background: var(--pending); } .instructions { background: var(--custom); }
.assistant { padding: 0 18px; } .thinking pre { color: var(--muted); font-style: italic; }
.time { font-size: 10px; color: var(--dim); }
.title { font-weight: bold; margin-bottom: 6px; } .muted { color: var(--muted); font-weight: normal; margin-top: 12px; }
.accent { color: var(--accent); }
.model { color: var(--muted); padding: 0 18px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.output { margin-top: 12px; color: var(--muted); }
.expandable { cursor: pointer; } .expandable .full, .expandable.expanded .preview { display: none; } .expandable.expanded .full { display: block; }
.hint { color: var(--dim); font-style: italic; }
.hidden { display: none !important; }
</style></head><body>
<aside><div class="controls"><input id="search" type="search" placeholder="Search...">
<button data-filter="default" class="active">Default</button><button data-filter="no-tools">No-tools</button><button data-filter="user">User</button><button data-filter="all">All</button></div>
<nav>${nav}</nav></aside>
<main><div class="header"><h1>Codex session</h1>
Session: ${escapeHtml(meta.id)}<br>Originator: ${escapeHtml(meta.originator)} · Codex ${escapeHtml(meta.cli_version)}<br>
Working directory: ${escapeHtml(meta.cwd)}<br>Started: ${escapeHtml(meta.timestamp)}<br>
${count("user")} user messages · ${count("assistant")} assistant messages · ${count("tool")} tool calls · local snapshot<br>
Rollout: ${escapeHtml(resolve(source))}</div>
${cards}</main>
<script nonce="${nonce}">
const shown = { default: (k) => k !== "instructions", "no-tools": (k) => k !== "instructions" && k !== "tool", user: (k) => k === "user", all: () => true };
let filter = "default";
function apply() {
  const query = document.getElementById("search").value.toLowerCase();
  for (const node of document.querySelectorAll(".node")) {
    const card = document.getElementById(node.dataset.target);
    const visible = shown[filter](node.dataset.kind) && (!query || card.textContent.toLowerCase().includes(query));
    node.classList.toggle("hidden", !visible);
    card.classList.toggle("hidden", !visible);
  }
}
for (const button of document.querySelectorAll("button[data-filter]"))
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll("button[data-filter]")) other.classList.toggle("active", other === button);
    apply();
  });
document.getElementById("search").addEventListener("input", apply);
document.addEventListener("click", (event) => {
  const node = event.target.closest(".node");
  if (node) {
    for (const other of document.querySelectorAll(".node.active")) other.classList.remove("active");
    node.classList.add("active");
    document.getElementById(node.dataset.target).scrollIntoView({ block: "start" });
  }
  const more = event.target.closest(".expandable");
  if (more && !String(getSelection())) more.classList.toggle("expanded");
});
apply();
</script>
</body></html>`;
  // Never overwrite a rollout or an existing export; keep private data local.
  writeFileSync(destination, html, { flag: "wx", mode: 0o600 });
  console.log(`Exported ${entries.length} entries to ${resolve(destination)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
