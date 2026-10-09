// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowControls } from "./WindowControls";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [false, "Linux x86_64"],
  [true, "MacIntel"],
])(
  "does not render outside native Linux or Windows (%s, %s)",
  (native, platform) => {
    vi.mocked(isTauri).mockReturnValue(native);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<WindowControls />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  },
);

it.each(["Linux x86_64"])(
  "supports keyboard window actions and retry on %s",
  async (platform) => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
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
    render(<WindowControls />);
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Minimize window" }),
    ).toHaveFocus();
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
  },
);

// Exercise the policy in the real component, including keyboard Close and retry.
it.each([
  [false, false],
  [false, true],
  [true, true],
])(
  "respects native policy minimize=%s maximize=%s",
  async (minimize, maximize) => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    vi.stubGlobal("__BUZZ_WINDOW_CONTROLS__", { minimize, maximize });
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(undefined);
    vi.mocked(getCurrentWindow).mockReturnValue({
      close,
    } as unknown as ReturnType<typeof getCurrentWindow>);
    const user = userEvent.setup();
    render(<WindowControls />);
    expect(
      screen.queryByRole("button", { name: "Minimize window" }) !== null,
    ).toBe(minimize);
    expect(
      screen.queryByRole("button", { name: "Maximize or restore window" }) !==
        null,
    ).toBe(maximize);
    for (
      let index = 0;
      index < 1 + Number(minimize) + Number(maximize);
      index++
    )
      await user.tab();
    expect(screen.getByRole("button", { name: "Close window" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Window action failed",
    );
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(2);
  },
);
