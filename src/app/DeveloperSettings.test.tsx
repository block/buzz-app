// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DeveloperSettings } from "./DeveloperSettings";
import { logLevel, setLogLevel } from "../features/developer/logging";
import type { RelayData } from "../features/relay/service";
const relay = { clearCache: vi.fn() } as unknown as RelayData;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLogLevel("info");
});
it("loads the saved level, changes it live, and displays remote changes", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    Response.json({
      logLevel: init?.body ? JSON.parse(String(init.body)).logLevel : "debug",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<DeveloperSettings relay={relay} />);
  const control = screen.getByRole("combobox", { name: "Log level" });
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveTextContent("Debug");
  await user.tab();
  expect(control).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: "Trace" });
  await user.keyboard("{End}{Enter}");
  await waitFor(() => expect(control).toHaveTextContent("Trace"));
  expect(logLevel()).toBe("trace");
  act(() => setLogLevel("warn"));
  expect(control).toHaveTextContent("Warn");
});
it("shows save failure without pretending the level was persisted", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("", { status: 500 })
        : Response.json({ logLevel: "debug" }),
    ),
  );
  render(<DeveloperSettings relay={relay} />);
  const control = screen.getByRole("combobox", { name: "Log level" });
  await waitFor(() => expect(control).toBeEnabled());
  await user.tab();
  expect(control).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: "Silent" });
  await user.keyboard("{Home}{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Log level wasn’t saved",
  );
  expect(control).toHaveTextContent("Debug");
  expect(control).toBeEnabled();
});
