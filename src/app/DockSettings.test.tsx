// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDockBadge,
  type DockPermission,
} from "../features/notifications/dock";
import { DockSettings } from "./DockSettings";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
});
function setup(initial: DockPermission) {
  const permission = vi.fn(async (): Promise<DockPermission> => initial);
  const dock = createDockBadge({ permission, set: vi.fn(async () => {}) });
  cleanups.push(dock.dispose);
  render(<DockSettings dock={dock} />);
  return { permission, dock };
}
it("requests permission only through the explicit Settings button and updates status", async () => {
  const h = setup("default");
  await act(() => h.dock.refresh());
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(screen.getByText(/not a message count/)).toBeInTheDocument();
  let resolve!: (permission: DockPermission) => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Allow notifications and badges" }),
  );
  expect(
    screen.getByRole("button", { name: "Allow notifications and badges" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Waiting for system permission…"),
  ).toBeInTheDocument();
  await act(async () => {
    resolve("enabled");
    await h.dock.refresh();
  });
  expect(
    screen.getByText("Dock badges are allowed by macOS."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Allow notifications and badges" }),
  ).not.toBeInTheDocument();
});
it.each(["disabled", "denied", "unavailable"] as const)(
  "never offers a request over %s",
  async (permission) => {
    const h = setup(permission);
    await act(() => h.dock.refresh());
    expect(
      screen.queryByRole("button", { name: "Allow notifications and badges" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check Dock permission" }));
    expect(h.permission.mock.calls).toEqual([[false], [false]]);
  },
);
