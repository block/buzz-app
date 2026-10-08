import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const script = new URL(
  "../../scripts/export-claude-session.mjs",
  import.meta.url,
);
function fixture(t, records) {
  const dir = mkdtempSync(join(tmpdir(), "claude-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "session.jsonl");
  writeFileSync(
    source,
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return { source, output: join(dir, "session.html") };
}
function run(source, output) {
  return spawnSync(process.execPath, [fileURLToPath(script), source, output], {
    encoding: "utf8",
  });
}

test("exports messages and tool activity as inert text without changing the transcript", (t) => {
  const payload =
    '<script>alert("x")</script><img src="https://example.test/">';
  const { source, output } = fixture(t, [
    { type: "queue-operation" },
    {
      type: "user",
      sessionId: "s1",
      cwd: "/work",
      message: { content: payload },
    },
    {
      type: "assistant",
      message: {
        model: "test-model",
        content: [
          { type: "text", text: "A reply" },
          {
            type: "tool_use",
            id: 'call"><img src=x>',
            name: "Bash",
            input: { command: payload },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: 'call"><img src=x>',
            is_error: true,
            content: "command not found",
          },
        ],
      },
    },
  ]);
  const before = readFileSync(source, "utf8");
  const result = run(source, output);
  assert.equal(result.status, 0, result.stderr);
  const dom = new JSDOM(readFileSync(output, "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("article").length, 3);
  assert.equal(document.querySelector("article pre").textContent, payload);
  assert.match(
    document.body.textContent,
    /A reply.*Tool: Bash.*Tool result · error.*command not found/s,
  );
  assert.equal(document.querySelectorAll("script, img, iframe, a").length, 0);
  assert.equal(readFileSync(source, "utf8"), before);
});

test("incomplete JSON reports its line without creating an export", (t) => {
  const { source, output } = fixture(t, [
    { type: "user", message: { content: "hello" } },
  ]);
  writeFileSync(source, `${readFileSync(source, "utf8")}\n{"type":`);
  const result = run(source, output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid JSON on line 2/);
  assert.throws(() => readFileSync(output), { code: "ENOENT" });
});

test("refuses to overwrite the transcript or an existing export", (t) => {
  const { source, output } = fixture(t, [
    { type: "user", message: { content: "hello" } },
  ]);
  const before = readFileSync(source, "utf8");
  writeFileSync(output, "existing export");
  for (const destination of [source, output]) {
    const result = run(source, destination);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EEXIST/);
  }
  assert.equal(readFileSync(source, "utf8"), before);
  assert.equal(readFileSync(output, "utf8"), "existing export");
});
