import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PagesService } from "./service";

it("validates the primary flag and exposes it on registered pages", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(root);
  const scope = root.extend({
    pluginOwner: { id: "example", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    const base = { id: "main", title: "Main", component: () => null };
    for (const primary of [null, "yes", 1, {}])
      expect(() => ctx.pages.register({ ...base, primary } as never)).toThrow();
    ctx.pages.register({ ...base, id: "listed", primary: true });
    // Omitting the flag keeps a page registered without a navigation row.
    ctx.pages.register({ ...base, id: "vended" });
  });
  await fiber.await();
  expect(pages.snapshot().map((page) => [page.id, page.primary])).toEqual([
    ["listed", true],
    ["vended", undefined],
  ]);
  await fiber.dispose();
  expect(pages.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

describe("page icon validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function registerMain(fields: object) {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const pages = new PagesService(root);
    const scope = root.extend({
      pluginOwner: { id: "example", revision: "one" },
    });
    const fiber = scope.plugin((ctx) => {
      ctx.pages.register({
        id: "main",
        title: "Main",
        component: () => null,
        ...fields,
      } as never);
    });
    // A bad icon must not fail plugin activation.
    await expect(fiber.await().then(() => "activated")).resolves.toBe(
      "activated",
    );
    const snapshot = pages.snapshot();
    await root.fiber.dispose();
    return snapshot;
  }

  it.each([
    "data:image/svg+xml,%3Csvg%3E",
    "data:image/png;base64,iVBOR",
    "DATA:IMAGE/PNG;base64,iVBOR",
    "data:image/png,",
  ])("keeps %j on the registered page without a warning", async (icon) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = await registerMain({ icon });
    expect(snapshot.map((page) => page.key)).toEqual(["example/main"]);
    expect(snapshot[0]?.icon).toEqual(icon);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", "data:image/", null, 1, {}])(
    "drops %j with one warning naming the page and still registers it",
    async (icon) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const snapshot = await registerMain({ icon });
      expect(snapshot.map((page) => page.key)).toEqual(["example/main"]);
      expect(Object.keys(snapshot[0] ?? {})).not.toContain("icon");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("example/main"),
      );
    },
  );

  it.each([
    "data:image/png;base64",
    "https://example.com/a.png",
    "/bestie.png",
    "blob:https://buzz.example/5d1e",
    "javascript:alert(1)",
    " data:image/png,x",
  ])(
    "drops %j with one warning that names the page but not the value",
    async (icon) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const snapshot = await registerMain({ icon });
      expect(snapshot.map((page) => page.key)).toEqual(["example/main"]);
      expect(Object.keys(snapshot[0] ?? {})).not.toContain("icon");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("example/main"),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(icon));
    },
  );

  it("an absent icon registers the page without an icon key or a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = await registerMain({});
    expect(snapshot.map((page) => page.key)).toEqual(["example/main"]);
    expect(Object.keys(snapshot[0] ?? {})).not.toContain("icon");
    expect(warn).not.toHaveBeenCalled();
  });
});
