// Opt-in real Codex acceptance, confined to a disposable directory. No relay writes.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { build } from "rolldown";
const root = new URL("../", import.meta.url);
const output = await mkdtemp(join(tmpdir(), "buzz-codex-test-"));
await build({
  input: {
    run: new URL("src/run.ts", root).pathname,
    history: new URL("src/history.ts", root).pathname,
  },
  plugins: [
    {
      name: "text",
      async load(id) {
        if (id.endsWith(".md"))
          return `export default ${JSON.stringify(await readFile(id, "utf8"))}`;
      },
    },
  ],
  output: { dir: output, entryFileNames: "[name].mjs", format: "esm" },
});
const { createRunner } = await import(join(output, "run.mjs"));
const { conversationHistory } = await import(join(output, "history.mjs"));
const { AppServer } = await import(new URL("../src/rpc.ts", import.meta.url));
const records = [];
const children = new Set();
const connect = async (_id, options) => {
  const child = spawn(
    "codex",
    [
      "app-server",
      "-c",
      `mcp_servers={${["buzz-dev-mcp", "other-company-tools", "company.tools"].map((name) => `${JSON.stringify(name)}={command="sh",args=${JSON.stringify(["-c", `touch '${join(output, "mcp-must-not-start")}'`])}}`).join(",")}}`,
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    },
  );
  children.add(child);
  let buffer = "";
  let closed = false;
  let shutdownTimer;
  child.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const record = JSON.parse(line);
      // config/read can contain local credentials; never retain its values in evidence.
      records.push(
        record.result?.config ? { id: record.id, configRead: true } : record,
      );
      options.onLine(line);
    }
  });
  child.on("exit", () => {
    clearTimeout(shutdownTimer);
    children.delete(child);
    options.onClose(new Error("Codex exited"));
  });
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", close);
    child.stdin.end();
    shutdownTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 3000);
    options.onClose(new Error("Closed"));
  };
  options.signal.addEventListener("abort", close, { once: true });
  return {
    send: async (text) => {
      const sent = JSON.parse(text);
      if (sent.params?.config?.mcp_servers)
        sent.params.config.mcp_servers = Object.fromEntries(
          Object.keys(sent.params.config.mcp_servers).map((name) => [
            name,
            { enabled: false },
          ]),
        );
      records.push({ sent });
      await new Promise((res, rej) =>
        child.stdin.write(`${text}\n`, (e) => (e ? rej(e) : res())),
      );
    },
    close,
  };
};
const controller = new AbortController();
const stored = new Map();
const published = [];
const steps = [];
const live = {
  step(init) {
    const step = { ...init, text: "", state: "running" };
    steps.push(step);
    return {
      append(text) {
        step.text += text;
      },
      finish(result) {
        if (step.state !== "running") return;
        Object.assign(step, result, {
          state: result?.error ? "error" : "done",
        });
      },
    };
  },
};
let eventId = 0;
const delivery = (text) => ({
  event: {
    id: (++eventId).toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content: text,
    tags: [
      ["h", "test-channel"],
      ["e", "b".repeat(64), "", "reply"],
    ],
  },
  channelId: "test-channel",
  conversation: { channelName: "codex-test", threadRootId: "b".repeat(64) },
  agent: {
    id: "test-codex",
    pubkey: "c".repeat(64),
    owner: "a".repeat(64),
    name: "Codex",
    workspace: { path: output },
    publish: async (event) => {
      published.push(event);
      return { id: "d".repeat(64), created_at: Math.floor(Date.now() / 1000) };
    },
  },
  config: {
    model: process.env.BUZZ_CODEX_TEST_MODEL ?? "gpt-5.6-luna",
    effort: "low",
    instructions:
      "Follow the test request exactly. These are local acceptance tests, including explicit fixture gates. Do not delegate.",
  },
  signal: controller.signal,
  live,
  cancelQueued() {},
});
const runner = createRunner(
  connect,
  {
    get: (k) => stored.get(k),
    set: (k, v) => stored.set(k, v),
    delete: (k) => stored.delete(k),
  },
  (d) =>
    conversationHistory(d, async (filters) =>
      filters[0]?.kinds?.includes(9)
        ? [
            {
              id: "e".repeat(64),
              kind: 9,
              pubkey: "f".repeat(64),
              created_at: 1,
              tags: [
                ["h", d.channelId],
                ["e", "b".repeat(64), "", "reply"],
              ],
              content:
                "Context-only test fact: the history verification word is APRICOT_927.",
            },
          ]
        : [],
    ),
);
async function condition(test, description) {
  const deadline = Date.now() + 180000;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  console.log("Workspace:", output);
  await runner(delivery("/steer This must not start a turn"), "local-test");
  assert.equal(records.length, 0);
  assert.match(published.pop().content, /not running a turn/);
  const first = runner(
    delivery(
      'Run this exact bash command first: touch started; while [ ! -f release ]; do sleep 0.1; done; printf "tool-loop-ok\\n" > seed.txt; cat seed.txt . Then use your file editing tool to create original.txt containing ORIGINAL. Read back your files and report the result. This fixture wait is explicitly requested.',
    ),
    "local-test",
  );
  await condition(
    () =>
      access(join(output, "started")).then(
        () => true,
        () => false,
      ),
    "first tool started",
  );
  const queued = runner(
    delivery(
      "/queue Read seed.txt and steered.txt using a shell tool. Reply QUEUED_OK followed by their contents and the history verification word from the earlier conversation. Do not edit files.",
    ),
    "local-test",
  );
  await runner(
    delivery(
      "/steer After the current command finishes, create steered.txt containing STEERED using your file editing tool, instead of original.txt. Your final reply must include STEERED_OK.",
    ),
    "local-test",
  );
  await writeFile(join(output, "release"), "go");
  await first;
  await queued;
  assert.equal(
    (await readFile(join(output, "seed.txt"), "utf8")).trim(),
    "tool-loop-ok",
  );
  assert.equal(
    (await readFile(join(output, "steered.txt"), "utf8")).trim(),
    "STEERED",
  );
  await assert.rejects(access(join(output, "original.txt")));
  assert.equal(published.length, 2);
  assert.match(published[0].content, /STEERED_OK/);
  assert.match(published[1].content, /QUEUED_OK/);
  assert.match(published[1].content, /APRICOT_927/);
  assert.equal(new Set([...stored.values()].map((v) => v.threadId)).size, 1);
  const saved = [...stored.values()][0];
  const inspect = await new AppServer().open(connect, controller.signal);
  const result = await inspect.request("thread/read", {
    threadId: saved.threadId,
    includeTurns: true,
  });
  console.log(
    "Thread:",
    saved.threadId,
    "Turns:",
    result.thread.turns?.length,
    "Rollout:",
    result.thread.path,
  );
  assert.equal(
    result.thread.name,
    "Buzz #codex-test · thread bbbbbbbb · Codex",
  );
  const rollout = (await readFile(result.thread.path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const metadata = rollout.find((r) => r.type === "session_meta");
  assert.match(
    metadata.payload.base_instructions.text,
    /Incoming Turn Contract/,
  );
  assert.match(
    metadata.payload.base_instructions.text,
    /Codex plugin delivery/,
  );
  assert(rollout.some((r) => JSON.stringify(r).includes("<buzz-event>")));
  assert(rollout.some((r) => JSON.stringify(r).includes("<thread-context>")));
  assert(
    rollout.some((r) =>
      JSON.stringify(r).includes(
        "<new-message-arrived-while-you-were-working>",
      ),
    ),
  );
  inspect.close();
  console.log(
    "PASS tools, base system prompt, turn contract, steering, queue, and persisted resume",
  );
  const long = runner(
    delivery(
      "Run exactly: touch cancel-started; while [ ! -f never-release ]; do sleep 0.1; done; touch must-not-exist. This is an interruption test; do not run other tools.",
    ),
    "local-test",
  );
  await condition(
    () =>
      access(join(output, "cancel-started")).then(
        () => true,
        () => false,
      ),
    "interrupt tool started",
  );
  const dropped = runner(
    delivery("/queue Create queue-must-not-run.txt"),
    "local-test",
  );
  await runner(delivery("/stop"), "local-test");
  await long;
  await dropped;
  await condition(() => children.size === 0, "interrupted process exited");
  await writeFile(join(output, "never-release"), "released after stop");
  await assert.rejects(access(join(output, "must-not-exist")));
  await assert.rejects(access(join(output, "queue-must-not-run.txt")));
  assert.match(published.at(-1).content, /Stopped Codex/);
  console.log("PASS interruption and queue cancellation");
  const abort = new AbortController();
  const beforeAbort = published.length;
  const aborted = runner(
    {
      ...delivery(
        "Run exactly: touch abort-started; while [ ! -f abort-release ]; do sleep 0.1; done; touch abort-must-not-exist. This is a lifecycle cancellation test.",
      ),
      signal: abort.signal,
    },
    "local-test",
  );
  // Observe rejection immediately; the process is cancelled after its tool gate starts.
  const rejected = assert.rejects(aborted);
  await condition(
    () =>
      access(join(output, "abort-started")).then(
        () => true,
        () => false,
      ),
    "abort tool started",
  );
  abort.abort();
  await rejected;
  await condition(() => children.size === 0, "cancelled process exited");
  await writeFile(join(output, "abort-release"), "released after cancellation");
  await assert.rejects(access(join(output, "abort-must-not-exist")));
  assert.equal(published.length, beforeAbort);
  await runner(
    delivery(
      "Read seed.txt and reply RECOVERED_OK with its contents. Do not run any earlier instructions or wait on fixture gates.",
    ),
    "local-test",
  );
  assert.match(published.at(-1).content, /RECOVERED_OK/);
  await assert.rejects(access(join(output, "must-not-exist")));
  await assert.rejects(access(join(output, "abort-must-not-exist")));
  assert.equal([...stored.values()][0].threadId, saved.threadId);
  console.log("PASS lifecycle cancellation and recovery in the same session");
  const updated = delivery(
    "Briefly acknowledge this request. No tools needed.",
  );
  updated.config.instructions =
    "Every final answer MUST contain the exact marker INSTRUCTIONS_UPDATED. This replaces the previous agent instructions.";
  await runner(updated, "local-test");
  assert.match(published.at(-1).content, /INSTRUCTIONS_UPDATED/);
  assert.equal([...stored.values()][0].threadId, saved.threadId);
  console.log("PASS edited instructions on resumed session");
  assert(
    !records.some((r) => r.method === "item/agentMessage/delta"),
    "server must suppress response deltas",
  );
  assert(
    steps.some(
      (step) => step.kind === "message" && step.text.includes("RECOVERED_OK"),
    ),
    "completed reply is visible in activity",
  );
  assert(
    !records.some((r) => r.params?.item?.type === "mcpToolCall"),
    "tools must be native Codex tools",
  );
  assert(
    !records.some(
      (r) =>
        r.params?.item?.type === "commandExecution" &&
        /(?:^|[\s;&|])buzz(?:\s|$)/.test(r.params.item.command),
    ),
    "Buzz CLI publishing must not be attempted",
  );
  const channelTurn = (text, root) => {
    const d = delivery(text);
    d.conversation = { channelName: "codex-channel-test" };
    d.event.tags[1][1] = root;
    return runner(d, "local-test");
  };
  const channelFirst = channelTurn(
    "Run this exact bash command first: `touch channel-started; while [ ! -f channel-release ]; do sleep 0.1; done`. Then reply CHANNEL_ONE. This is an explicit fixture gate.",
    "e".repeat(64),
  );
  await condition(
    () =>
      access(join(output, "channel-started")).then(
        () => true,
        () => false,
      ),
    "channel tool started",
  );
  await channelTurn(
    "/steer Reply CHANNEL_STEERED after the current command completes.",
    "f".repeat(64),
  );
  await writeFile(join(output, "channel-release"), "go");
  await channelFirst;
  assert.match(published.at(-1).content, /CHANNEL_STEERED/);
  assert(
    published
      .at(-1)
      .tags.some((tag) => tag[0] === "e" && tag[1] === "f".repeat(64)),
    "accepted cross-thread steering changes the final reply destination",
  );
  await channelTurn("Reply CHANNEL_TWO. No tools needed.", "f".repeat(64));
  assert.equal(
    stored.size,
    2,
    "channel policy reuses one session across Buzz threads",
  );
  const channelSession = [...stored.values()].find(
    (v) => v.threadId !== saved.threadId,
  );
  const names = await new AppServer().open(connect, controller.signal);
  const named = await names.request("thread/read", {
    threadId: channelSession.threadId,
    includeTurns: true,
  });
  assert.equal(named.thread.name, "Buzz #codex-channel-test · Codex");
  assert.equal(named.thread.turns.length, 2);
  names.close();
  await assert.rejects(access(join(output, "mcp-must-not-start")));
  console.log(
    "PASS no text streaming, all inherited MCP servers disabled, native-only tools, named thread and channel sessions",
  );
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(
      { threadId: saved.threadId, published, steps, records },
      null,
      2,
    ),
  );
  console.log("Evidence:", join(output, "evidence.json"));
} finally {
  controller.abort();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
