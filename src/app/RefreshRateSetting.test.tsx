// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { RefreshRateSetting } from "./RefreshRateSetting";

const native = vi.hoisted(() => ({ value: true }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  native.value = true;
});

/** Native storage holding `saved`; `null` is a WebKit that cannot apply it. */
function nativeChoice(saved: boolean | null) {
  const state = { saved };
  invoke.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "render_rate_preference") return state.saved;
    if (command === "render_rate_set")
      state.saved = (args as { enabled: boolean }).enabled;
  });
  return state;
}
const toggle = () =>
  screen.getByRole("switch", { name: "Match display refresh rate" });
/** Waits for the latest native call to finish. */
async function settled() {
  const result = invoke.mock.results.at(-1);
  expect(result).toBeDefined();
  await act(async () => {
    await Promise.resolve(result?.value).catch(() => {});
  });
}

it("is off until the owner opts in, and keeps the choice for the next launch", async () => {
  const user = userEvent.setup();
  const state = nativeChoice(false);
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  expect(await screen.findByRole("switch")).not.toBeChecked();
  expect(toggle()).toHaveAccessibleDescription(
    /Takes effect after restarting Buzz/,
  );
  await user.click(toggle());
  expect(toggle()).toBeChecked();
  expect(invoke).toHaveBeenLastCalledWith("render_rate_set", {
    enabled: true,
  });
  await settled();
  expect(state.saved).toBe(true);
  cleanup();
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  expect(await screen.findByRole("switch")).toBeChecked();
});

it("is not offered where it cannot take effect", async () => {
  native.value = false;
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  cleanup();

  native.value = true;
  nativeChoice(null);
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  await settled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  cleanup();

  // Other desktop platforms have no such command.
  invoke.mockRejectedValue("Command render_rate_preference not found");
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  await settled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("says an unsaved choice will not apply and retries the same choice", async () => {
  const user = userEvent.setup();
  const state = nativeChoice(false);
  render(<RefreshRateSetting />, { wrapper: ToastProvider });
  await screen.findByRole("switch");
  invoke.mockRejectedValueOnce("Could not save the refresh rate choice.");
  await user.click(toggle());
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Refresh rate choice wasn’t saved",
  );
  expect(toggle()).toBeChecked();
  expect(state.saved).toBe(false);
  await user.click(
    screen.getByRole("button", { name: "Retry saving refresh rate" }),
  );
  expect(state.saved).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
