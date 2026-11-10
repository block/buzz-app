import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarHeaderService } from "./sidebar-header-service";

const header = {
  version: 1 as const,
  id: "workspace",
  title: "Example workspace",
  onTitle: () => {},
};

function rootContext() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  return root;
}

afterEach(() => vi.restoreAllMocks());

it("registers a versioned header under its owner and disposes it with the plugin", async () => {
  const root = rootContext();
  const registry = new SidebarHeaderService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => ctx.reflect.get("sidebarHeader")?.register(header));
  await fiber.await();

  expect(registry.snapshot()).toMatchObject([
    {
      ...header,
      key: "example.plugin/workspace",
      pluginId: "example.plugin",
      revision: "one",
    },
  ]);
  await fiber.dispose();
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("ignores an unsupported contribution version without failing activation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = rootContext();
  const registry = new SidebarHeaderService(root);
  await root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) =>
      ctx.reflect
        .get("sidebarHeader")
        ?.register({ ...header, version: 2 } as never),
    )
    .await();

  expect(registry.snapshot()).toEqual([]);
  expect(warn).toHaveBeenCalledOnce();
  await root.fiber.dispose();
});

it.each([
  ["an invalid id", { ...header, id: "Bad Id" }],
  ["a blank title", { ...header, title: " " }],
  ["a missing title action", { ...header, onTitle: undefined }],
  [
    "rows without select",
    { ...header, rows: { snapshot: () => [], subscribe: () => () => {} } },
  ],
  ["incomplete rows", { ...header, rows: {}, select: () => ({}) }],
])("rejects %s", async (_name, value) => {
  const root = rootContext();
  const registry = new SidebarHeaderService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => ctx.sidebarHeader?.register(value as never));

  await expect(fiber.await()).rejects.toThrow(/sidebar header/);
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("lets a plugin activate on an older host without a sidebar header", async () => {
  const root = new Context();
  const applied = vi.fn();
  await root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.reflect.get("sidebarHeader")?.register(header);
      applied();
    })
    .await();

  expect(applied).toHaveBeenCalledOnce();
  await root.fiber.dispose();
});
