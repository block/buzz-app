// Real Codex transport and persistence, synthetic account and loopback model, no external model or relay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "rolldown";
import manifest from "./manifest.json" with { type: "json" };
const declaration = manifest.host.processes[1];

const root = await realpath(
  await mkdtemp(join(tmpdir(), "buzz-codex-isolation-")),
);
const shared = join(root, "desktop");
const isolated =
  process.platform === "darwin"
    ? join(root, "Library/Application Support/Buzz/codex")
    : join(root, "data/buzz/codex");
const servers = [];
const model = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const item = {
      type: "message",
      id: "fixture-message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Fixture completed.", annotations: [] },
      ],
    };
    const result = {
      id: "fixture-response",
      object: "response",
      created_at: 1,
      model: "fixture-model",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      {
        type: "response.created",
        response: { ...result, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: "Fixture completed.",
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ])
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
});
try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await mkdir(shared);
  await writeFile(
    join(shared, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "synthetic-isolation-fixture" }),
  );
  // Even an explicit shared SQLite path must be overridden in the private store.
  const configuration = `model = "gpt-5.3-codex"
sqlite_home = "${shared}"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`;
  await writeFile(join(shared, "config.toml"), configuration);
  await build({
    input: new URL("./rpc.ts", import.meta.url).pathname,
    output: { dir: root, entryFileNames: "rpc.mjs", format: "esm" },
  });
  const { AppServer } = await import(join(root, "rpc.mjs"));
  const nativeSpawn = async (id, options = {}) => {
    assert.equal(id, "app-server");
    const child = spawn("sh", [...declaration.args, ...options.args], {
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        CODEX_HOME: shared,
        CODEX_SQLITE_HOME: shared,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => options.onStdout?.(String(data)));
    child.stderr.on("data", (data) => options.onStderr?.(String(data)));
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return {
      write: (data) =>
        new Promise((resolve, reject) =>
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      end: async () => child.stdin.end(),
      kill: async () => child.kill("SIGKILL"),
      exited,
    };
  };
  const open = async (store) => {
    const rpc = new AppServer();
    servers.push(rpc);
    await rpc.open(nativeSpawn, undefined, store);
    return rpc;
  };
  const create = async (rpc, text) => {
    const { thread } = await rpc.request("thread/start", {
      cwd: root,
      ephemeral: false,
      model: "fixture-model",
      modelProvider: "fixture",
    });
    let complete;
    const finished = new Promise((resolve) => {
      complete = resolve;
    });
    const off = rpc.onMessage((wire) => {
      if (
        wire.method === "turn/completed" &&
        wire.params.threadId === thread.id
      )
        complete(wire.params.turn);
    });
    try {
      await rpc.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text, text_elements: [] }],
      });
      assert.equal((await finished).status, "completed");
    } finally {
      off();
    }
    return thread.id;
  };
  const has = async (rpc, id) => {
    const { data } = await rpc.request("thread/list", {
      limit: 100,
      modelProviders: ["fixture"],
    });
    return data.some((thread) => thread.id === id);
  };
  const legacy = await open("legacy");
  const oldId = await create(legacy, "Legacy fixture remains resumable");
  await legacy.close();
  const beforeAuth = await readFile(join(shared, "auth.json"));
  const current = await open("isolated");
  assert.equal(
    (await current.request("account/read", { refreshToken: false })).account
      .type,
    "apiKey",
  );
  assert.equal(
    (await current.request("config/read", {})).config.sqlite_home,
    isolated,
  );
  const newId = await create(
    current,
    "Isolated fixture persists after restart",
  );
  await current.close();
  const restarted = await open("isolated");
  assert.equal(
    (await restarted.request("thread/resume", { threadId: newId })).thread.id,
    newId,
  );
  assert.equal(await has(restarted, newId), true);
  assert.equal(await has(restarted, oldId), false);
  await restarted.close();
  const desktop = await open("legacy");
  assert.equal(
    (await desktop.request("thread/resume", { threadId: oldId })).thread.id,
    oldId,
  );
  assert.equal(await has(desktop, oldId), true);
  assert.equal(await has(desktop, newId), false);
  await desktop.close();
  assert.deepEqual(await readFile(join(shared, "auth.json")), beforeAuth);
  assert.equal(
    await readFile(join(shared, "config.toml"), "utf8"),
    configuration,
  );
  assert.ok(
    (await readdir(isolated)).some(
      (name) => name.startsWith("state_") && name.endsWith(".sqlite"),
    ),
  );
  console.log(
    "PASS: shared synthetic sign-in/config, private SQLite/history, restart resume, and preserved legacy sessions; local fixture model only; no external model or relay calls",
  );
} finally {
  await Promise.all(servers.map((rpc) => rpc.close()));
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
