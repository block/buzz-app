// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { AgentSettings } from "./AgentSettings";
import {
  rememberAgentsPreference,
  setRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import {
  keepAwakePreference,
  setKeepAwakePreference,
} from "../features/agents/keep-awake";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setRememberAgentsPreference(true);
  setKeepAwakePreference({ mode: "off", after: 60 });
  localStorage.clear();
});

it("offers keeping the Mac awake only where the app can, with a wait for Automatic", async () => {
  const user = userEvent.setup();
  const view = render(<AgentSettings keepAwakeAvailable={false} />, {
    wrapper: ToastProvider,
  });
  expect(
    screen.queryByRole("combobox", { name: "Keep this Mac awake" }),
  ).not.toBeInTheDocument();
  view.rerender(<AgentSettings keepAwakeAvailable />);
  const mode = screen.getByRole("combobox", { name: "Keep this Mac awake" });
  expect(mode).toHaveTextContent("Off");
  expect(
    screen.queryByRole("combobox", { name: "Turn off after" }),
  ).not.toBeInTheDocument();
  await user.click(mode);
  await user.click(await screen.findByRole("option", { name: "Automatic" }));
  const after = screen.getByRole("combobox", { name: "Turn off after" });
  expect(after).toHaveTextContent("1 hour");
  await user.click(after);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual([
    "30 minutes",
    "1 hour",
    "2 hours",
    "4 hours",
    "8 hours",
    "12 hours",
  ]);
  await user.click(screen.getByRole("option", { name: "8 hours" }));
  expect(keepAwakePreference()).toEqual({ mode: "auto", after: 480 });
  expect(localStorage.getItem("buzz-keep-awake.v1")).toBe(
    JSON.stringify({ mode: "auto", after: 480 }),
  );
});

it("defaults on, persists opt-out, and follows another window's preference", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const toggle = () =>
    screen.getByRole("switch", { name: "Remember mentioned agents" });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(rememberAgentsPreference()).toBe(false);
  cleanup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.removeItem("buzz-remember-mentioned-agents.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-remember-mentioned-agents.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved opt-out effective and offers retry without changing the choice", async () => {
  const user = userEvent.setup();
  const view = render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  expect(rememberAgentsPreference()).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("could not be saved");
  view.rerender(<AgentSettings active={false} />);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(<AgentSettings />);
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be saved",
  );
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving mentioned agents" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
});

it("does not prefill when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(rememberAgentsPreference()).toBe(false);
});
