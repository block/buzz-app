import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { ObjectsService } from "./service";

it("resolves the first healthy active provider and removes disposed registrations", async () => {
  const root = new Context();
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const objects = new ObjectsService(root);
  const scope = root.extend({ pluginOwner: { id: "test", revision: "one" } });
  const fiber = scope.plugin((ctx) => {
    ctx.objects.register({
      id: "broken",
      title: "Broken",
      identify: () => {
        throw new Error("broken");
      },
      load: async () => {
        throw new Error("unused");
      },
    });
    ctx.objects.register({
      id: "github",
      title: "GitHub",
      identify: (target) =>
        target.includes("github.com")
          ? {
              provider: "github",
              key: "pull:1",
              kind: "pull",
              url: target,
              label: "#1",
            }
          : undefined,
      load: async (reference) => ({
        reference,
        title: "A pull request",
        facts: [],
      }),
    });
  });
  await fiber.await();
  expect(objects.resolve("https://github.com/block/buzz/pull/1")).toMatchObject(
    {
      provider: { id: "github" },
      reference: { label: "#1" },
    },
  );
  await expect(
    objects.load(
      "https://github.com/block/buzz/pull/1",
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ title: "A pull request" });
  active = false;
  for (const listener of listeners) listener();
  expect(
    objects.resolve("https://github.com/block/buzz/pull/1"),
  ).toBeUndefined();
  await fiber.dispose();
  await root.fiber.dispose();
});
