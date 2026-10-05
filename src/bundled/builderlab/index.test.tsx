// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsCardsService } from "../../features/settings/service";
import * as builderlab from "./index";
import * as hosted from "../hosted-communities";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
});

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

it("plugin disposal cancels a queued login before its response and fences the removed card", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const fiber = root
    .extend({
      pluginOwner: { id: "block.builderlab", revision: "bundled" },
    })
    .plugin({ ...builderlab, name: "builderlab" });
  let finish!: () => void;
  const queued = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "plugin:builderlab|login") {
      await queued;
      throw "Builderlab authentication canceled";
    }
    if (command === "plugin:builderlab|auth") return null;
    if (command === "plugin:builderlab|cancel") return;
    throw new Error(`Unexpected command: ${command}`);
  });
  try {
    await fiber.await();
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const Card = cards.snapshot()[0]?.component;
    if (!Card) throw new Error("Builderlab card was not registered");
    render(<Card active={() => cards.has("block.builderlab/login")} />);
    const signIn = screen.getByRole("button", {
      name: "Sign in with Builderlab",
    });
    await waitFor(() => expect(signIn).toBeEnabled());
    fireEvent.click(signIn);
    expect(invoke).toHaveBeenCalledWith("plugin:builderlab|login");
    // Leave the IPC response unresolved until Cordis finishes actual disposal.
    await act(async () => {
      await fiber.dispose();
    });
    expect(cards.snapshot()).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith("plugin:builderlab|cancel");
    const calls = vi.mocked(invoke).mock.calls.length;
    await act(async () => {
      finish();
      await queued;
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("plugin:builderlab|sign_out");
  } finally {
    finish();
    await root.fiber.dispose();
  }
});
