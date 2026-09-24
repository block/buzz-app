import { afterEach, expect, it, vi } from "vitest";
import { createPluginStorage } from "./storage";
import type { PluginInfo } from "./types";
const catalog = (): PluginInfo[] =>
  ["buzz.channels", "buzz.github"].map((id) => ({
    manifest: { id, name: id, apiVersion: 1 },
    source: "bundled",
    enabled: true,
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
  }));
afterEach(() => vi.unstubAllGlobals());
it("ignores the retired Welcome setting and changes each bundled plugin independently", async () => {
  const values = new Map([
    ["buzzodz.plugins.v1", JSON.stringify({ version: 1, enabled: false })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const installation = createPluginStorage(catalog);
  expect(await installation.getCatalog()).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: true }],
    },
  });
  expect(
    await installation.changePlugin("disable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
  const reopened = createPluginStorage(catalog);
  expect(await reopened.changePlugin("enable", "buzz.channels")).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
});

it("restores required Channels from saved disabled settings and rejects disabling it", async () => {
  const saved = JSON.stringify({
    version: 2,
    enabled: {
      "buzz.channels": false,
      "buzz.github": false,
    },
  });
  const values = new Map([["buzzodz.plugins.v1", saved]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  for (let reopen = 0; reopen < 2; reopen++) {
    const storage = createPluginStorage(catalog);
    expect(await storage.getCatalog()).toMatchObject({
      status: "ready",
      catalog: { plugins: [{ enabled: true }, { enabled: false }] },
    });
    await expect(
      storage.changePlugin("disable", "buzz.channels"),
    ).rejects.toThrow("Channels is required");
    expect(values.get("buzzodz.plugins.v1")).toBe(saved);
  }
  expect(
    await createPluginStorage(catalog).changePlugin("enable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: { plugins: [{ enabled: true }, { enabled: true }] },
  });
});
