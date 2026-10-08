// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { createLocalBestie, type BestieState } from "./setup";
import { apply } from "./index";

vi.mock("./setup", () => ({ createLocalBestie: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function page(state: BestieState) {
  vi.mocked(createLocalBestie).mockReturnValue({
    snapshot: () => state,
    subscribe: () => () => {},
    retry: vi.fn(),
    dispose: vi.fn(async () => {}),
  });
  const open = vi.fn(async () => ({ status: "opened" as const }));
  let Page: ComponentType | undefined;
  apply({
    relay: {},
    agentControl: {},
    conversation: {},
    navigation: { open },
    effect: vi.fn(),
    pages: {
      register({ component }: { component: ComponentType }) {
        Page = component;
      },
    },
  } as unknown as Parameters<typeof apply>[0]);
  if (!Page) throw new Error("Bestie page was not registered");
  render(<Page />);
  return open;
}

it("opens the saved Local Bestie editor from a setup failure", async () => {
  const owner = "cd".repeat(32);
  const pubkey = "ab".repeat(32);
  const origin = "https://relay.example.test";
  const open = page({
    status: "error",
    message: "Databricks workspace is not configured.",
    record: {
      version: 1,
      owner,
      origin,
      request: "fixture-request",
      agent: { id: "fixture-agent", pubkey, committed: true },
      home: { id: "fixture-home" },
    },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Databricks workspace is not configured.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Edit Local Bestie" }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: { viewer: owner, communityOrigin: origin },
    route: { version: 1, params: { pubkey } },
  });
});

it("offers Agent settings before there is a saved agent to edit", async () => {
  const open = page({
    status: "error",
    message: "Could not check local agents.",
  });
  expect(
    screen.queryByRole("button", { name: "Edit Local Bestie" }),
  ).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Agent settings" }));
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "settings",
    section: "agents",
  });
});
