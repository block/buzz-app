// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registerNavigationShortcuts } from "../../app/shortcuts";
import type {
  AgentProviderSnapshot,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import { ShortcutsService } from "../../features/shortcuts/service";
import { AgentDefaults } from "./AgentDefaults";

afterEach(cleanup);

function fixture(initial: AgentProviderSnapshot = { readiness: "ready" }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const type = {
    key: "local/echo",
    pluginId: "local",
    revision: "1",
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
    provider: {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check() {},
      DialogBody: () => <p>Echo controls</p>,
    },
  } satisfies RegisteredAgentType;
  const types = [type];
  const agents = {
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
  const update = (next: AgentProviderSnapshot) =>
    act(() => {
      state = next;
      for (const listener of listeners) listener();
    });
  return { type, agents, update };
}

it("keeps an unrouted provider a local dialog that Back does not close", async () => {
  const { agents } = fixture();
  render(<AgentDefaults agents={agents} />);
  fireEvent.click(screen.getByRole("button", { name: "Echo, ready" }));
  const dialog = await screen.findByRole("dialog", { name: "Echo" });
  expect(dialog).not.toHaveAttribute("data-navigation-visit");
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(ctx, window);
  const controller = createNavigationController(createMemoryHistory());
  const remove = registerNavigationShortcuts(shortcuts, controller.navigation);
  try {
    const behind = { version: 1, kind: "settings" } as const;
    void controller.navigation.open({ version: 1, kind: "home" });
    void controller.navigation.open(behind);
    await vi.waitFor(() =>
      expect(controller.navigation.snapshot().canGoBack).toBe(true),
    );
    // Not prevented: the reserved chord stays inert over a plain modal.
    expect(fireEvent.keyDown(dialog, { key: "[", ctrlKey: true })).toBe(true);
    await act(async () => {});
    expect(controller.navigation.snapshot().attempt.entry.target).toEqual(
      behind,
    );
  } finally {
    remove();
    controller.dispose();
    await ctx.fiber.dispose();
  }
  expect(screen.getByRole("dialog", { name: "Echo" })).toBeVisible();
});

it("withholds a routed provider's visit while its work must be cancelled first", async () => {
  const { type, agents, update } = fixture({
    readiness: "attention",
    blocking: true,
  });
  const navigation = {
    target: {
      version: 1,
      kind: "settings",
      section: "agents",
      provider: type.key,
    },
    signal: new AbortController().signal,
  } as unknown as PageNavigation;
  render(
    <AgentDefaults
      agents={agents}
      navigation={navigation}
      onProvider={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "Echo" });
  expect(dialog).not.toHaveAttribute("data-navigation-visit");
  update({ readiness: "ready" });
  expect(dialog).toHaveAttribute("data-navigation-visit");
});
