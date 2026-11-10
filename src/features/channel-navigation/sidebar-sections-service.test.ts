import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSectionsService } from "./sidebar-sections-service";

const rows = {
  snapshot: () => [{ id: "row", label: "Row" }],
  subscribe: () => () => {},
};
const section = {
  version: 1 as const,
  id: "work",
  title: "Work",
  icon: "W",
  rows,
  select: () => ({ version: 1 as const, kind: "home" as const }),
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

it("registers a versioned section under its owner and disposes it with the plugin", async () => {
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => ctx.sidebarSections?.register(section));
  await fiber.await();

  expect(registry.snapshot()).toMatchObject([
    {
      ...section,
      key: "example.plugin/work",
      pluginId: "example.plugin",
      revision: "one",
    },
  ]);
  await fiber.dispose();
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("ignores an unsupported contribution version without failing plugin activation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const applied = vi.fn();
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.reflect.get("sidebarSections")?.register({
        ...section,
        version: 2,
      } as never);
      applied();
    });

  await fiber.await();
  expect(registry.snapshot()).toEqual([]);
  expect(applied).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  await root.fiber.dispose();
});

it("lets a plugin use an older host that does not provide sidebar sections", async () => {
  const root = new Context();
  const registerPage = vi.fn();
  root.provide("pages", { register: registerPage } as never);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.reflect.get("sidebarSections")?.register(section);
      ctx.pages.register({
        id: "page",
        title: "Page",
        component: () => null,
      });
    });

  await fiber.await();
  expect(registerPage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "page", title: "Page" }),
  );
  await root.fiber.dispose();
});

it("accepts an optional footer row and rejects an incomplete one", async () => {
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  const footer = { label: "Add item", onSelect: () => {} };
  await scope
    .plugin((ctx) => ctx.sidebarSections?.register({ ...section, footer }))
    .await();
  expect(registry.snapshot()).toMatchObject([{ footer }]);

  for (const bad of [
    { label: " ", onSelect: () => {} },
    { label: "Add item" },
    null,
  ]) {
    const fiber = root
      .extend({ pluginOwner: { id: "example.other", revision: "one" } })
      .plugin((ctx) =>
        ctx.sidebarSections?.register({
          ...section,
          footer: bad as never,
        }),
      );
    await expect(fiber.await()).rejects.toThrow(/sidebar section/);
  }
  await root.fiber.dispose();
});
