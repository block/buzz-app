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
