// The coding tools against real files and a real bash.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import {
  codingTools,
  findCommand,
  grepCommand,
  MAX_CHARS,
  MAX_LINES,
  tail,
} from "../src/tools.ts";
import { nodeWorkspace } from "./workspace.ts";

function bench() {
  const workspace = nodeWorkspace();
  const stopper = new AbortController();
  const tools = codingTools(workspace, stopper.signal);
  const call = <Name extends keyof typeof tools>(name: Name, input: object) =>
    (
      tools[name].execute as (input: object, options: object) => Promise<string>
    )((tools[name].inputSchema as z.ZodType<object>).parse(input), {
      toolCallId: "t",
      messages: [],
    });
  return { workspace, stopper, call };
}

test("write, read and ls work on files inside the workspace only", async () => {
  const { workspace, call } = bench();
  assert.equal(
    await call("write", { path: "src/a.txt", content: "one\ntwo\nthree" }),
    "Wrote 13 characters to src/a.txt.",
  );
  await call("write", { path: ".env", content: "" });
  assert.equal(await call("read", { path: "src/a.txt" }), "one\ntwo\nthree");
  assert.equal(
    await call("read", { path: `${workspace.path}/src/a.txt`, offset: 3 }),
    "three",
  );
  assert.equal(await call("ls", {}), ".env\nsrc/");
  assert.equal(await call("ls", { path: "src" }), "a.txt");
  await assert.rejects(call("read", { path: "../x" }), /outside/);
  await assert.rejects(
    call("write", { path: "/tmp/x", content: "" }),
    /outside/,
  );
});

test("a long file is read a part at a time, with where to continue", async () => {
  const { call } = bench();
  const lines = Array.from({ length: MAX_LINES + 500 }, (_, i) => `l${i + 1}`);
  await call("write", { path: "long.txt", content: lines.join("\n") });
  assert.equal(
    await call("read", { path: "long.txt", offset: 2, limit: 2 }),
    `l2\nl3\n\n[Lines 2-3 of ${lines.length}. Use offset=4 to continue.]`,
  );
  const first = await call("read", { path: "long.txt" });
  assert.ok(first.startsWith("l1\nl2\n"));
  assert.ok(
    first.endsWith(
      `l${MAX_LINES}\n\n[Lines 1-${MAX_LINES} of ${lines.length}. Use offset=${MAX_LINES + 1} to continue.]`,
    ),
  );
  await assert.rejects(
    call("read", { path: "long.txt", offset: 9999 }),
    /past the end/,
  );

  // Few lines, but more text than one result may carry.
  await call("write", {
    path: "wide.txt",
    content: Array.from({ length: 30 }, () => "x".repeat(4000)).join("\n"),
  });
  const wide = await call("read", { path: "wide.txt" });
  assert.ok(wide.length < MAX_CHARS + 100);
  assert.match(wide, /\[Lines 1-12 of 30\. Use offset=13 to continue\.\]$/);
  await call("write", { path: "line.txt", content: "y".repeat(MAX_CHARS) });
  assert.match(await call("read", { path: "line.txt" }), /^\[Line 1 is longer/);
});

test("edit replaces text that occurs exactly once, all edits or none", async () => {
  const { workspace, call } = bench();
  const original = "const a = 1;\nconst b = 2;\nconst c = 2;\n";
  await call("write", { path: "a.ts", content: original });
  assert.equal(
    await call("edit", {
      path: "a.ts",
      edits: [
        { oldText: "c = 2", newText: "c = 3" },
        { oldText: "a = 1", newText: "a = 10" },
      ],
    }),
    "Applied 2 edits to a.ts.",
  );
  const edited = "const a = 10;\nconst b = 2;\nconst c = 3;\n";
  assert.equal(await workspace.readFile("a.ts"), edited);

  const refused = async (edits: object[], message: RegExp) => {
    await assert.rejects(call("edit", { path: "a.ts", edits }), message);
    assert.equal(await workspace.readFile("a.ts"), edited);
  };
  await refused([{ oldText: "d = 4", newText: "" }], /edits\[0\].*is not in/);
  await refused([{ oldText: "const ", newText: "let " }], /more than once/);
  await refused(
    [
      { oldText: "b = 2", newText: "b = 5" },
      { oldText: "missing", newText: "" },
    ],
    /edits\[1\]/,
  );
  await refused(
    [
      { oldText: "const b = 2;", newText: "" },
      { oldText: "b = 2;\nconst c", newText: "" },
    ],
    /overlap/,
  );
  await refused([{ oldText: "b = 2", newText: "b = 2" }], /change nothing/);
});

test("bash returns output in order and reports how the command ended", async () => {
  const { workspace, stopper, call } = bench();
  assert.equal(await call("bash", { command: "pwd" }), workspace.path);
  assert.equal(
    await call("bash", { command: "echo out; echo err >&2; echo out2" }),
    "out\nerr\nout2",
  );
  assert.equal(await call("bash", { command: "true" }), "(no output)");
  await assert.rejects(
    call("bash", { command: "echo before; exit 3" }),
    /^Error: before\n\nCommand exited with code 3$/,
  );
  await assert.rejects(
    call("bash", { command: "echo started; sleep 30", timeout: 0.3 }),
    /^Error: started\n\nCommand timed out$/,
  );
  const running = call("bash", { command: "echo started; sleep 30" });
  setTimeout(() => stopper.abort(), 200);
  await assert.rejects(running, /Command was cancelled$/);
});

test("long output keeps its end", async () => {
  const { call } = bench();
  const output = await call("bash", { command: "seq 1 100000" });
  assert.ok(output.length < MAX_CHARS + 100);
  assert.match(
    output,
    /^\[Earlier output is not shown\. This is the end of it\.\]\n/,
  );
  assert.ok(output.endsWith("\n99999\n100000"));
  assert.ok(output.split("\n").length <= MAX_LINES + 1);

  assert.equal(tail("a\nb\n"), "a\nb");
  assert.equal(tail(""), "");
  const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => i).join("\n");
  assert.ok(tail(many).endsWith(`\n${MAX_LINES}`));
  assert.equal(tail(many).split("\n").length, MAX_LINES + 1);
  // One line too long to keep whole: its end, under the notice.
  const [notice, kept] = tail("z".repeat(MAX_CHARS + 5)).split("\n");
  assert.match(notice ?? "", /^\[Earlier output is not shown/);
  assert.equal(kept, "z".repeat(MAX_CHARS));
});

test("grep and find search the workspace and survive shell characters", async () => {
  const { workspace, call } = bench();
  await call("write", {
    path: "src/app.ts",
    content: "let a = 1;\nTODO: it's\n",
  });
  await call("write", {
    path: "src/deep/app.test.ts",
    content: "todo later\n",
  });
  await call("write", { path: "notes.md", content: "TODO: it's\n" });
  await call("write", { path: "it's a file.md", content: "x\n" });
  await call("write", { path: ".git/config", content: "TODO: it's\n" });

  const sorted = (text: string) => text.split("\n").sort();
  assert.deepEqual(sorted(await call("grep", { pattern: "TODO: it's" })), [
    "./notes.md:1:TODO: it's",
    "./src/app.ts:2:TODO: it's",
  ]);
  assert.deepEqual(
    sorted(
      await call("grep", { pattern: "todo", ignoreCase: true, glob: "*.ts" }),
    ),
    ["./src/app.ts:2:TODO: it's", "./src/deep/app.test.ts:1:todo later"],
  );
  assert.equal(
    await call("grep", { pattern: "a = 1", path: "src/app.ts", context: 1 }),
    "src/app.ts:1:let a = 1;\nsrc/app.ts-2-TODO: it's",
  );
  assert.equal(
    await call("grep", { pattern: "$(touch pwned)", literal: true }),
    "No matches.",
  );
  assert.equal(
    (await call("grep", { pattern: "TODO|todo", limit: 1 })).split("\n").length,
    1,
  );

  assert.equal(
    await call("find", { pattern: "*.ts" }),
    "src/app.ts\nsrc/deep/app.test.ts",
  );
  assert.equal(
    await call("find", { pattern: "*.ts", path: "src/deep" }),
    "app.test.ts",
  );
  assert.equal(await call("find", { pattern: "it's*" }), "it's a file.md");
  assert.equal(
    await call("find", { pattern: "*.rs; touch pwned" }),
    "No files.",
  );
  assert.equal(await call("ls", {}), ".git/\nit's a file.md\nnotes.md\nsrc/");

  // The same searches where ripgrep is not installed.
  const without = (command: string) =>
    call("bash", {
      command: command.replaceAll("command -v rg", "command -v no-such-rg"),
    });
  assert.deepEqual(
    sorted(await without(grepCommand({ pattern: "TODO: it's" }))),
    ["./notes.md:1:TODO: it's", "./src/app.ts:2:TODO: it's"],
  );
  assert.equal(
    await without(findCommand({ pattern: "*.test.ts" })),
    "src/deep/app.test.ts",
  );
  assert.equal(
    await without(findCommand({ pattern: "src/*.ts" })),
    "src/app.ts\nsrc/deep/app.test.ts",
  );
  assert.ok(workspace.commands.length > 0);
});
