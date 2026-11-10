import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { SidebarScopeService } from "./sidebar-scope-service";

const banner = () => null;

function rootContext() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  return root;
}

it("registers solo and all restrictions under their owner and disposes them with the plugin", async () => {
  const root = rootContext();
  const registry = new SidebarScopeService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.sidebarScope.restrict({ id: "quiet", scope: "solo", banner });
      ctx.sidebarScope.restrict({ id: "bare", scope: "all" });
    });
  await fiber.await();

  expect(registry.snapshot()).toMatchObject([
    { key: "example.plugin/quiet", scope: "solo" },
    { key: "example.plugin/bare", scope: "all" },
  ]);
  await fiber.dispose();
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("returns a remover for one restriction", async () => {
  const root = rootContext();
  const registry = new SidebarScopeService(root);
  let remove = () => {};
  await root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      remove = ctx.sidebarScope.restrict({ id: "bare", scope: "all" });
    })
    .await();

  remove();
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it.each([
  ["a missing scope", { id: "bad", banner }],
  ["an unknown scope", { id: "bad", scope: "team", banner }],
  ["a solo restriction without a banner", { id: "bad", scope: "solo" }],
  [
    "an all restriction with a non-component banner",
    {
      id: "bad",
      scope: "all",
      banner: "text",
    },
  ],
  ["an invalid id", { id: "Bad Id", scope: "all" }],
])("rejects %s", async (_name, restriction) => {
  const root = rootContext();
  const registry = new SidebarScopeService(root);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => ctx.sidebarScope.restrict(restriction as never));

  await expect(fiber.await()).rejects.toThrow(/sidebar restriction/);
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
