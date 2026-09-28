// Explicit staged-runtime check, not part of ordinary compiler-only integration tests.
// Run: bin/node --test tests/integration/agent-audience-smoke.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tools = join(root, "src-tauri/resources/agent-runtime");
const binary = join(tools, process.platform === "win32" ? "buzz.exe" : "buzz");
test("staged CLI signs explicit coordination/answers while preserving recipients and thread roots", {
  timeout: 60_000,
}, async (t) => {
  const spec = JSON.parse(
    await readFile(join(root, "runtime/agent-runtime.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(tools, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.revision, spec.revision);
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    manifest.files[process.platform === "win32" ? "buzz.exe" : "buzz"],
  );
  const home = await mkdtemp(join(tmpdir(), "buzz-audience-smoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const key = generateSecretKey(),
    author = getPublicKey(key),
    peer = getPublicKey(generateSecretKey());
  const relayKey = generateSecretKey();
  const channel = "123e4567-e89b-12d3-a456-426614174000";
  const sign = (kind, tags, content = "") =>
    finalizeEvent(
      { kind, tags, content, created_at: Math.floor(Date.now() / 1000) },
      relayKey,
    );
  const parent = sign(9, [["h", channel]], "Synthetic request");
  const roster = sign(39002, [
    ["d", channel],
    ["p", author],
    ["p", peer],
  ]);
  const published = [],
    requests = [];
  let denied = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(req.url);
      res.setHeader("content-type", "application/json");
      if (req.url === "/query") {
        const filters = Array.isArray(body) ? body : [body];
        const rows = filters.some((f) => f.ids?.includes(parent.id))
          ? [parent]
          : filters.some((f) => f.kinds?.includes(39002))
            ? [
                denied
                  ? sign(39002, [
                      ["d", channel],
                      ["p", author],
                    ])
                  : roster,
              ]
            : [];
        res.end(JSON.stringify(rows));
      } else if (req.url === "/events") {
        assert.equal(verifyEvent(body), true);
        published.push(body);
        res.end(JSON.stringify({ accepted: true, event_id: body.id }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    TMPDIR: home,
    PATH: "/usr/bin:/bin",
    BUZZ_RELAY_URL: origin,
    BUZZ_PRIVATE_KEY: Buffer.from(key).toString("hex"),
  };
  const run = (args) =>
    new Promise((resolve, reject) => {
      // Synthetic key only, confined to the child; never inherit a developer key/provider.
      const child = spawn(binary, args, {
        cwd: home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const base = [
    "messages",
    "send",
    "--channel",
    channel,
    "--content",
    "Synthetic message",
  ];
  for (const args of [base, [...base, "--audience", "invalid"]]) {
    const result = await run(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /audience/);
    assert.equal(
      requests.length,
      0,
      "invalid/absent audience must fail before network work",
    );
  }
  for (const kind of [9, 45001, 45003]) {
    for (const audience of ["agents", "everyone"]) {
      const args = [
        ...base,
        "--kind",
        String(kind),
        "--audience",
        audience,
        "--mention",
        peer,
      ];
      if (kind !== 45001) args.push("--reply-to", parent.id);
      const result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      const event = published.at(-1);
      assert.equal(event.pubkey, author);
      assert.equal(event.kind, kind);
      assert.deepEqual(
        event.tags.filter(([name]) => name === "audience"),
        [["audience", audience]],
      );
      assert.ok(
        event.tags.some(([name, value]) => name === "h" && value === channel),
      );
      assert.ok(
        event.tags.some(([name, value]) => name === "p" && value === peer),
      );
      if (kind !== 45001)
        assert.ok(
          event.tags.some(
            ([name, value, , marker]) =>
              name === "e" &&
              value === parent.id &&
              ["root", "reply"].includes(marker),
          ),
        );
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.audience, audience);
      assert.equal(receipt.event_id, event.id);
      assert.deepEqual(receipt.mention_pubkeys, [peer]);
    }
  }
  assert.equal(published.length, 6);
  denied = true;
  const rejected = await run([
    ...base,
    "--audience",
    "agents",
    "--mention",
    peer,
  ]);
  assert.notEqual(rejected.code, 0);
  assert.equal(
    published.length,
    6,
    "audience must not bypass recipient membership",
  );
});
