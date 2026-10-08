// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import {
  LaunchWindowControls,
  LoadingWindowHeader,
} from "./LaunchWindowControls";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  [true, "Linux x86_64", true],
  [true, "Win32", true],
  [true, "MacIntel", false],
  [false, "Linux x86_64", false],
])(
  "gates launch chrome native=%s platform=%s",
  (native, platform, expected) => {
    vi.mocked(isTauri).mockReturnValue(native);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    document.body.innerHTML =
      '<div id="buzz-launch"></div><div id="root" inert aria-hidden="true"></div>';
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing test root");
    const mounted = render(<LaunchWindowControls />, { container: root });
    expect(
      screen.queryByRole("group", { name: "Window controls" }) !== null,
    ).toBe(expected);
    expect(root.querySelector("header")).toBeNull();
    mounted.unmount();
    expect(document.querySelector("header")).toBeNull();
  },
);

it("removes the portal after fading without mutating root isolation itself", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  });
  document.body.innerHTML =
    '<div id="buzz-launch"></div><div id="root" inert aria-hidden="true"></div>';
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing test root");
  render(<LaunchWindowControls />, { container: root });
  expect(root).toHaveAttribute("inert");
  const { setLaunchReady } = await import("../launch");
  await act(async () => setLaunchReady(true));
  expect(
    screen.getByRole("group", { name: "Window controls" }),
  ).toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(240);
  });
  expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
  expect(root).not.toHaveAttribute("inert");
});

it("provides chrome during a later restore without a parser overlay", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  render(<LoadingWindowHeader />);
  expect(
    screen.getByRole("group", { name: "Window controls" }),
  ).toBeInTheDocument();
  expect(document.querySelector("header")).toHaveAttribute(
    "data-tauri-drag-region",
    "true",
  );
});

it("applies the native policy on the very first launch render", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.stubGlobal("__BUZZ_WINDOW_CONTROLS__", {
    minimize: false,
    maximize: false,
  });
  document.body.innerHTML =
    '<div id="buzz-launch"></div><div id="root" inert aria-hidden="true"></div>';
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing test root");
  render(<LaunchWindowControls />, { container: root });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Close window" }),
  ).toBeInTheDocument();
  expect(root.querySelector("header")).toBeNull();
});
