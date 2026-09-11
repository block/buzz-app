import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { Plugin, UserConfigFnPromise, ViteDevServer } from "vite";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import viteConfig from "../../../vite.config";

// Mock only the credential boundary. The Vite config, plugin registration,
// default identity loader and public-key match are the production path.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
const readCredential = vi.mocked(execFileSync);
const config = viteConfig as UserConfigFnPromise;
const fixture = generateSecretKey();
const viewer = getPublicKey(fixture);
const credential = JSON.stringify({ identity: nip19.nsecEncode(fixture) });
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  vi.stubEnv("BUZZ_RELAY_URL", "");
  vi.stubEnv("BUZZ_COMMUNITY_ALIASES", "");
  vi.stubEnv("BUZZ_DEV_VIEWER", "");
  readCredential.mockReset();
  readCredential.mockReturnValue(Buffer.from(credential));
});
afterEach(() => {
  for (const server of servers.splice(0)) server.emit("close");
  vi.unstubAllEnvs();
});

async function startup(command: "serve" | "build" = "serve") {
  const resolved = await config({
    command,
    mode: command === "serve" ? "development" : "production",
  });
  const plugin = (resolved.plugins as Plugin[]).find(
    (entry) => entry.name === "buzz-relay-broker",
  );
  const server = createServer();
  servers.push(server);
  const use = vi.fn();
  const info = vi.fn();
  const start = () => {
    assert.exists(plugin);
    return (plugin.configureServer as (server: ViteDevServer) => Promise<void>)(
      {
        httpServer: server,
        config: { logger: { info, error: vi.fn() } },
        middlewares: { use },
      } as unknown as ViteDevServer,
    );
  };
  return { resolved, plugin, start, use, info };
}

it.each(["", "  "])(
  "starts without the broker or credential access when no public pin is configured (%#)",
  async (configured) => {
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    expect(app.plugin).toBeUndefined();
    expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"0"');
    expect(readCredential).not.toHaveBeenCalled();
  },
);

it("never registers the broker for production builds, even with a configured pin", async () => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  const app = await startup("build");
  expect(app.plugin).toBeUndefined();
  expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"0"');
  expect(readCredential).not.toHaveBeenCalled();
});

it.each([
  "not-a-key",
  "ab".repeat(31),
  "npub1broken",
  nip19.nsecEncode(fixture),
])(
  "rejects missing/invalid public configuration before Keychain access (%#)",
  async (configured) => {
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    await expect(app.start()).rejects.toThrow(
      "Set BUZZ_DEV_VIEWER in .env.local",
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(app.use).not.toHaveBeenCalled();
    expect(app.info).not.toHaveBeenCalled();
  },
);

it.each([viewer, nip19.npubEncode(viewer), ` ${viewer.toUpperCase()} `])(
  "uses the explicit matching public identity through Vite startup (%#)",
  async (configured) => {
    vi.stubEnv("BUZZ_DEV_VIEWER", configured);
    const app = await startup();
    await app.start();
    expect(readCredential).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "buzz-desktop", "-a", "secrets", "-w"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
    );
    expect(app.use).toHaveBeenCalledOnce();
    expect(app.info).toHaveBeenCalledWith(
      expect.stringContaining(`signing as ${viewer.slice(0, 8)}`),
    );
    expect(app.resolved.define?.["import.meta.env.VITE_BUZZ_LIVE"]).toBe('"1"');
    expect(JSON.stringify(app.resolved.define)).not.toContain(
      "BUZZ_DEV_VIEWER",
    );
    expect(JSON.stringify(app.info.mock.calls)).not.toContain(credential);
  },
);

it("rejects a different Keychain identity instead of adopting it", async () => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  readCredential.mockReturnValue(
    Buffer.from(
      JSON.stringify({ identity: nip19.nsecEncode(generateSecretKey()) }),
    ),
  );
  const app = await startup();
  await expect(app.start()).rejects.toThrow(
    "Keychain identity does not match BUZZ_DEV_VIEWER",
  );
  expect(app.use).not.toHaveBeenCalled();
  expect(app.info).not.toHaveBeenCalled();
});

it("fails closed when Keychain access is denied without leaking command output", async () => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  readCredential.mockImplementation(() => {
    throw new Error(credential);
  });
  const app = await startup();
  await expect(app.start()).rejects.toThrow(
    "Keychain read unavailable or declined; no credential fallback",
  );
  expect(app.use).not.toHaveBeenCalled();
  expect(app.info).not.toHaveBeenCalled();
});

it.each([
  "not-json",
  "{}",
  JSON.stringify({ identity: "not-nip19" }),
  JSON.stringify({ identity: nip19.npubEncode(viewer) }),
])("rejects malformed or non-secret Keychain entries (%#)", async (raw) => {
  vi.stubEnv("BUZZ_DEV_VIEWER", viewer);
  readCredential.mockReturnValue(Buffer.from(raw));
  const app = await startup();
  await expect(app.start()).rejects.toThrow(
    /Keychain identity .*; no credential fallback/,
  );
  expect(app.use).not.toHaveBeenCalled();
  expect(app.info).not.toHaveBeenCalled();
});

it("loads the public pin from .env.local and lets explicit environment override it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-viewer-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    delete process.env.BUZZ_DEV_VIEWER;
    writeFileSync(
      join(dir, ".env.local"),
      `BUZZ_DEV_VIEWER=${nip19.npubEncode(viewer)}\n`,
    );
    const app = await startup();
    await app.start();
    expect(app.use).toHaveBeenCalledOnce();

    vi.stubEnv("BUZZ_DEV_VIEWER", getPublicKey(generateSecretKey()));
    const overridden = await startup();
    await expect(overridden.start()).rejects.toThrow(
      "does not match BUZZ_DEV_VIEWER",
    );
    expect(overridden.use).not.toHaveBeenCalled();
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
