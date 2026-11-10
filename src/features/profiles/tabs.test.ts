import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { flush } from "../relay/testing";
import { ProfileTabsService } from "./tabs";

function root() {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  return ctx;
}

it("lists a plugin's tab while the plugin is on", async () => {
  const ctx = root();
  const tabs = new ProfileTabsService(ctx);
  const scope = ctx.extend({
    pluginOwner: { id: "example.profiles", revision: "one" },
  });
  const fiber = scope.plugin((plugin) => {
    plugin.reflect.get("profileTabs")?.register({
      id: "details",
      title: "Details",
      component: () => null,
    });
  });
  await fiber.await();
  await flush();
  expect(tabs.snapshot().map(({ key, title }) => [key, title])).toEqual([
    ["example.profiles/details", "Details"],
  ]);

  await fiber.dispose();
  expect(tabs.snapshot()).toEqual([]);
  await ctx.fiber.dispose();
});

it("rejects a tab without an id, a title or a component", async () => {
  const ctx = root();
  const tabs = new ProfileTabsService(ctx);
  for (const tab of [
    { id: "Bad Id", title: "Details", component: () => null },
    { id: "details", title: " ", component: () => null },
    { id: "details", title: "Details", component: "nope" },
    { id: "details", title: "Details", component: () => null, when: true },
  ])
    expect(() => tabs.register(tab as never)).toThrow(
      "Profile tabs need an id, a title and a component",
    );
  await ctx.fiber.dispose();
});
