import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { developerSettingsPlugin } from "./developer-settings.ts";
import { getLogger, setLogLevel } from "../src/features/developer/logging.ts";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  setLogLevel("info");
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), "buzz-logging-"));
  roots.push(root);
  return root;
}
async function harness(root) {
  let handler;
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  const send = vi.fn();
  developerSettingsPlugin(root).configureServer({
    middlewares: {
      use: (fn) => {
        handler = fn;
      },
    },
    ws: { send },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    send,
    base,
    get: () => fetch(`${base}/api/dev/settings`),
    post: (body, headers = {}) =>
      fetch(`${base}/api/dev/settings`, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          ...headers,
        },
        body,
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
it("persists live levels before broadcasting and restores after restart without a relay", async () => {
  const root = directory();
  let h = await harness(root);
  try {
    expect(await (await h.get()).json()).toEqual({ logLevel: "info" });
    const logger = getLogger("existing");
    expect((await h.post('{"logLevel":"debug"}')).status).toBe(200);
    expect(logger.level).toBe(4);
    expect(h.send).toHaveBeenCalledWith({
      type: "custom",
      event: "buzz:log-level",
      data: "debug",
    });
    expect(
      JSON.parse(
        readFileSync(join(root, ".buzz/developer-settings.json"), "utf8"),
      ),
    ).toEqual({ logLevel: "debug" });
  } finally {
    await h.close();
  }
  h = await harness(root);
  try {
    expect(await (await h.get()).json()).toEqual({ logLevel: "debug" });
  } finally {
    await h.close();
  }
});
it("rejects cross-origin, invalid and oversized writes without changing settings", async () => {
  const h = await harness(directory());
  try {
    for (const body of [
      "null",
      "{",
      "[]",
      '{"logLevel":"constructor"}',
      '{"logLevel":"debug","extra":1}',
    ])
      expect((await h.post(body)).status).toBe(400);
    expect((await h.post("x".repeat(257))).status).toBe(413);
    expect(
      (await h.post('{"logLevel":"debug"}', { origin: "https://other.test" }))
        .status,
    ).toBe(403);
    expect(
      (await h.post('{"logLevel":"debug"}', { "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(`${h.base}/api/dev/settings`, { method: "DELETE" })).status,
    ).toBe(405);
    expect(await (await h.get()).json()).toEqual({ logLevel: "info" });
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("keeps the active level when persistence fails and recovers from corrupt settings", async () => {
  const root = directory();
  mkdirSync(join(root, ".buzz"));
  writeFileSync(join(root, ".buzz/developer-settings.json"), "not-json");
  const h = await harness(root);
  try {
    expect(await (await h.get()).json()).toEqual({ logLevel: "info" });
    mkdirSync(join(root, ".buzz/developer-settings.json.tmp"));
    expect((await h.post('{"logLevel":"trace"}')).status).toBe(500);
    expect(await (await h.get()).json()).toEqual({ logLevel: "info" });
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
