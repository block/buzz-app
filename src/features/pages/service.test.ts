import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PagesService } from "./service";

it("validates and copies page navigation entries", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.nav", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    const base = {
      id: "nav",
      title: "Nav",
      component: () => null,
      route: { version: 1, validate: (params: unknown) => params === "inbox" },
    };
    for (const navigation of [
      {},
      [null],
      [{ icon: "/icon.svg" }],
      [{ title: " ", icon: "/icon.svg" }],
      [{ title: "Nav" }],
      [{ title: "Nav", icon: " " }],
      [{ title: "Nav", icon: "/icon.svg", requiresCommunity: "yes" }],
      // Params must select a view the page's own route accepts.
      [{ title: "Nav", icon: "/icon.svg", params: "outbox" }],
    ])
      expect(() =>
        ctx.pages.register({ ...base, navigation } as never),
      ).toThrow("navigation");
    expect(() =>
      ctx.pages.register({
        ...base,
        route: undefined,
        navigation: [{ title: "Nav", icon: "/icon.svg", params: "inbox" }],
      } as never),
    ).toThrow("navigation");
    const entry = {
      title: "Nav",
      icon: "/icon.svg",
      params: "inbox",
      requiresCommunity: true,
    };
    ctx.pages.register({ ...base, navigation: [entry] });
    entry.title = "Mutated";
  });
  await fiber.await();
  const [registered] = pages.snapshot();
  expect(registered?.navigation).toEqual([
    {
      title: "Nav",
      icon: "/icon.svg",
      params: "inbox",
      requiresCommunity: true,
    },
  ]);
  expect(Object.isFrozen(registered?.navigation)).toBe(true);
  expect(Object.isFrozen(registered?.navigation?.[0])).toBe(true);
  await fiber.dispose();
  await root.fiber.dispose();
});
