// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsCardsService } from "../../features/settings/service";
import * as builderlab from "./index";
import * as hosted from "../hosted-communities";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
afterEach(() => vi.mocked(isTauri).mockReturnValue(true));

it.each([true, false])(
  "provides exactly one account card on desktop=%s and removes it on disable",
  async (desktop) => {
    vi.mocked(isTauri).mockReturnValue(desktop);
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const cards = new SettingsCardsService(root);
    const fibers = [builderlab, hosted].map((module, i) =>
      root
        .extend({
          pluginOwner: {
            id: i ? "block.hosted-communities" : "block.builderlab",
            revision: "bundled",
          },
        })
        .plugin({ ...module, name: `account-${i}` }),
    );
    try {
      await Promise.all(fibers.map((fiber) => fiber.await()));
      await vi.waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      expect(cards.snapshot()[0]).toMatchObject({
        key: desktop
          ? "block.builderlab/login"
          : "block.hosted-communities/hosted",
        title: desktop ? "Builderlab" : "Hosted communities",
        group: desktop ? "Integrations" : "Communities",
      });
      // No credential access on application startup or plugin activation.
      expect(invoke).not.toHaveBeenCalled();
      for (const fiber of fibers) await fiber.dispose();
      await vi.waitFor(() => expect(cards.snapshot()).toHaveLength(0));
    } finally {
      await root.fiber.dispose();
    }
  },
);
