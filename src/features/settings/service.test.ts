import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import { SettingsCardsService } from "./service";

it("retains visibility for cards activated after Settings mounts", async () => {
  const root = new Context();
  const statusListeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe(listener: () => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  });
  const cards = new SettingsCardsService(root);
  const releaseVisibility = cards.retainVisibility();
  let visible = false;
  const visibilityListeners = new Set<() => void>();
  const release = vi.fn();
  const ensure = vi.fn(() => {
    visible = true;
    for (const listener of visibilityListeners) listener();
    return release;
  });
  const scope = root.extend({
    pluginOwner: { id: "moderation", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    ctx.settingsCards.register({
      id: "membership",
      title: "Membership",
      section: "administration",
      visibility: {
        snapshot: () => visible,
        subscribe(listener) {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
        ensure,
      },
      component: () => null,
    });
  });
  await fiber.await();
  await flush();

  expect(ensure).toHaveBeenCalledOnce();
  expect(cards.snapshot().map((card) => card.key)).toEqual([
    "moderation/membership",
  ]);

  await fiber.dispose();
  expect(release).toHaveBeenCalledOnce();
  releaseVisibility();
  await root.fiber.dispose();
});
