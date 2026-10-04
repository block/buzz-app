// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LinuxWindowControls } from "./LinuxWindowControls";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  [false, "Linux x86_64"],
  [true, "MacIntel"],
  [true, "Win32"],
])("does not render outside native Linux (%s, %s)", (native, platform) => {
  vi.mocked(isTauri).mockReturnValue(native);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  render(<LinuxWindowControls />);
  expect(screen.queryByRole("group")).not.toBeInTheDocument();
  expect(getCurrentWindow).not.toHaveBeenCalled();
});

it("supports keyboard window actions and reports a failure that can be retried", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const minimize = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  const toggleMaximize = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    minimize,
    toggleMaximize,
    close,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const user = userEvent.setup();
  render(<LinuxWindowControls />);
  await user.tab();
  expect(screen.getByRole("button", { name: "Minimize window" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Window action failed",
  );
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.tab();
  await user.keyboard("{Enter}");
  await user.tab();
  await user.keyboard(" ");
  expect(minimize).toHaveBeenCalledTimes(2);
  expect(toggleMaximize).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
