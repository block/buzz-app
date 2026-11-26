import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import initSqlJs from "sql.js";

// The built single-file MCP server opens and queries a table: SQLite must load
// from inside the bundle, with no sql.js files beside it.
test("the packaged MCP server reads a table's fields and rows", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "buzz-mcp-tables-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const build = spawnSync(
    "node_modules/.bin/vite",
    ["build", "--config", "vite.buzz-mcp.config.ts", "--outDir", out],
    { cwd: new URL("../..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);

  const agent = generateSecretKey();
  const me = getPublicKey(agent);
  const relayKey = generateSecretKey();
  // The agent's own private tables channel, as every session derives it.
  const digest = createHash("sha256")
    .update(`buzz.tables:channel:${me}`)
    .digest("hex");
  const channel = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${((Number.parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT); INSERT INTO goals VALUES ('g1','Ship the demo','active')",
  );
  const key = crypto.getRandomValues(new Uint8Array(32));
  const head = finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: encrypt(Buffer.from(db.export()).toString("base64"), key),
      tags: [
        ["d", "t1"],
        ["h", channel],
        ["type", "buzz.table"],
      ],
    },
    agent,
  );
  const grant = finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: encrypt(bytesToHex(key), getConversationKey(agent, me)),
      tags: [
        ["h", channel],
        ["type", "buzz.table-key"],
        ["for", me],
        ["table", "t1"],
      ],
    },
    agent,
  );
  const relayState = (kind) =>
    finalizeEvent(
      {
        kind,
        created_at: 1,
        content: "",
        tags:
          kind === 39000
            ? [["d", channel], ["private"]]
            : [
                ["d", channel],
                ["p", me, "", "owner"],
              ],
      },
      relayKey,
    );
  const relay = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url !== "/query") return response.end("{}");
      const [filter] = JSON.parse(body);
      const kind = filter?.kinds?.[0];
      response.end(
        JSON.stringify(
          kind === 39000 || kind === 39002
            ? [relayState(kind)]
            : filter?.artifact === "head"
              ? [head]
              : [grant],
        ),
      );
    });
  }).listen(0, "127.0.0.1");
  t.after(() => relay.close());
  await new Promise((resolve) => relay.once("listening", resolve));

  const server = spawn("node", [join(out, "buzz-mcp.mjs")], {
    cwd: out,
    env: {
      ...process.env,
      BUZZ_RELAY_URL: `ws://127.0.0.1:${relay.address().port}`,
      BUZZ_PRIVATE_KEY: bytesToHex(agent),
      BUZZ_MCP_ROOT: out,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => server.kill());
  const replies = new Map();
  let buffer = "";
  server.stdout.on("data", (data) => {
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      replies.set(++id, resolve);
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  const tool = async (name, args) =>
    (await call("tools/call", { name, arguments: args })).result.content[0]
      .text;
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });

  const [fields] = JSON.parse(await tool("table_fields", { table: "t1" }));
  assert.deepEqual(
    fields.columns.map((column) => column.name),
    ["id", "title", "status"],
  );
  assert.deepEqual(
    JSON.parse(
      await tool("table_query", {
        table: "t1",
        sql: "SELECT title FROM goals WHERE status = 'active'",
      }),
    ),
    { rows: [{ title: "Ship the demo" }], more: false },
  );
});
