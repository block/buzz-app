import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { createServer as createViteServer } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { developerSettingsPlugin } from "./developer-settings.ts";
import {
  developerSettings,
  getLogger,
  logLevel,
  setLogLevel,
} from "../src/features/developer/logging.ts";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  setLogLevel("info");
  vi.unstubAllEnvs();
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
    expect(await (await h.get()).json()).toEqual({
      logLevel: "info",
      revision: 0,
    });
    const logger = getLogger("existing");
    expect((await h.post('{"logLevel":"debug"}')).status).toBe(200);
    expect(logger.level).toBe(4);
    expect(await (await h.get()).json()).toEqual({
      logLevel: "debug",
      revision: 1,
    });
    expect(h.send).toHaveBeenCalledWith({
      type: "custom",
      event: "buzz:log-level",
      data: { logLevel: "debug", revision: 1 },
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
    expect(await (await h.get()).json()).toEqual({
      logLevel: "debug",
      revision: 0,
    });
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
      (
        await fetch(`${h.base}/api/dev/settings`, {
          method: "POST",
          body: '{"logLevel":"debug"}',
        })
      ).status,
    ).toBe(403);
    const hostile = await new Promise((resolve, reject) => {
      const req = request(
        `${h.base}/api/dev/settings`,
        {
          headers: { host: "hostile.test:1234" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(hostile).toBe(403);
    expect(
      (await fetch(`${h.base}/api/dev/settings`, { method: "DELETE" })).status,
    ).toBe(405);
    expect(await (await h.get()).json()).toEqual({
      logLevel: "info",
      revision: 0,
    });
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
    expect(await (await h.get()).json()).toEqual({
      logLevel: "info",
      revision: 0,
    });
    mkdirSync(join(root, ".buzz/developer-settings.json.tmp"));
    expect((await h.post('{"logLevel":"trace"}')).status).toBe(500);
    expect(await (await h.get()).json()).toEqual({
      logLevel: "info",
      revision: 0,
    });
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("makes no unsupported settings request and retains JSON fallback protection", async () => {
  vi.stubEnv("BUZZ_DEV_SETTINGS", "0");
  const root = directory();
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><title>Fallback</title>",
  );
  const server = await createViteServer({
    root,
    configFile: false,
    envDir: false,
    optimizeDeps: { noDiscovery: true },
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  let fetcher;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const request = globalThis.fetch;
    // Establish that this real server would serve HTML for an untyped request.
    const fallback = await request(`${base}/api/dev/settings`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    await fallback.text();
    const statuses = [];
    // Resolve the browser-relative URL only; preserve the production request.
    fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const response = await request(new URL(url, base), init);
        statuses.push(response.status);
        return response;
      });
    setLogLevel("debug");
    await expect(developerSettings()).rejects.toThrow(
      "Development settings are unavailable",
    );
    expect(statuses).toEqual([]);
    // Even an advertised endpoint that disappears must not get HTML fallback.
    vi.stubEnv("BUZZ_DEV_SETTINGS", "1");
    await expect(developerSettings()).rejects.toThrow(
      "Development settings are unavailable",
    );
    expect(statuses).toEqual([404]);
    expect(logLevel()).toBe("debug");
  } finally {
    fetcher?.mockRestore();
    await server.close();
  }
});

it("the real serving plugin advertises settings capability to Vite modules", async () => {
  const root = directory();
  writeFileSync(
    join(root, "capability.js"),
    "export default import.meta.env.BUZZ_DEV_SETTINGS;",
  );
  const server = await createViteServer({
    root,
    configFile: false,
    envDir: false,
    plugins: [developerSettingsPlugin(root)],
    optimizeDeps: { noDiscovery: true },
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    expect((await server.ssrLoadModule("/capability.js")).default).toBe("1");
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    expect(await (await fetch(`${base}/api/dev/settings`)).json()).toEqual({
      logLevel: "info",
      revision: 0,
    });
  } finally {
    await server.close();
  }
});
