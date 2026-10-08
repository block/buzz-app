// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  setChannelUsagePreference,
  showChannelUsage,
  useChannelUsagePreference,
} from "./channel-usage-preference";

function Probe() {
  return <span>{useChannelUsagePreference() ? "shown" : "hidden"}</span>;
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("defaults on and updates all mounted readers when Settings changes", () => {
  render(<Probe />);
  render(<Probe />);
  expect(screen.getAllByText("shown")).toHaveLength(2);
  act(() => {
    expect(setChannelUsagePreference(false)).toBeNull();
  });
  expect(screen.getAllByText("hidden")).toHaveLength(2);
  expect(showChannelUsage()).toBe(false);
  act(() => {
    expect(setChannelUsagePreference(true)).toBeNull();
  });
  expect(screen.getAllByText("shown")).toHaveLength(2);
});
it("responds to storage changes from another window and retains the last preference", () => {
  render(<Probe />);
  localStorage.setItem("buzz-show-channel-session-usage.v1", "off");
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-show-channel-session-usage.v1",
      }),
    );
  });
  expect(screen.getByText("hidden")).toBeTruthy();
  cleanup();
  render(<Probe />);
  expect(screen.getByText("hidden")).toBeTruthy();
});
