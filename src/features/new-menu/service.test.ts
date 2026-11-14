import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { NewMenuService } from "./service";

function rootContext(isActive = (_id: string, _revision: string) => true) {
  const root = new Context();
  const listeners = new Set<() => void>();
  const status = { isActive };
  root.provide("pluginStatus", {
    isActive: (id: string, revision: string) => status.isActive(id, revision),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    root,
    setActive(next: typeof isActive) {
      status.isActive = next;
      for (const listener of listeners) listener();
    },
  };
}

const item = {
  id: "linear",
  title: "New chat from Linear",
  group: "solo" as const,
  run: () => {},
};

it("registers an item under its owner and removes it when the plugin is disabled", async () => {
  const { root } = rootContext();
  const menu = new NewMenuService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => ctx.reflect.get("newMenu")?.register(item));
  await fiber.await();
  expect(menu.snapshot()).toMatchObject([
    { ...item, key: "example.plugin/linear", pluginId: "example.plugin" },
  ]);
  await fiber.dispose();
  expect(menu.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("hides an item once its plugin revision is replaced", async () => {
  const { root, setActive } = rootContext();
  const menu = new NewMenuService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => ctx.newMenu?.register(item));
  await fiber.await();
  expect(menu.snapshot()).toHaveLength(1);
  setActive((_id, revision) => revision === "two");
  expect(menu.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("rejects an item without an id, title, known group or run function", async () => {
  const { root } = rootContext();
  const menu = new NewMenuService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  for (const bad of [
    { ...item, id: "Linear" },
    { ...item, title: " " },
    { ...item, group: "inbox" },
    { ...item, run: "open" },
  ])
    expect(() => scope.newMenu?.register(bad as never)).toThrow(
      "A New menu item needs",
    );
  expect(menu.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
