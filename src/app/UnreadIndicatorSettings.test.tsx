// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createUnreadIndicator,
  type IndicatorPermission,
} from "../features/notifications/indicator";
import { UnreadIndicatorSettings } from "./UnreadIndicatorSettings";

const native = vi.hoisted(() => ({ value: true }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  native.value = true;
});
function setup(initial: IndicatorPermission) {
  const permission = vi.fn(async (): Promise<IndicatorPermission> => initial);
  const dock = createUnreadIndicator({
    permission,
    set: vi.fn(async () => {}),
  });
  cleanups.push(dock.dispose);
  render(<UnreadIndicatorSettings indicator={dock} />);
  return { permission, dock };
}
it("requests permission only through the explicit Settings button and updates status", async () => {
  const h = setup("default");
  await act(() => h.dock.refresh());
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(screen.getByText(/not a message count/)).toBeInTheDocument();
  let resolve!: (permission: IndicatorPermission) => void;
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

it("offers missing-badge setup only as an explicit action", async () => {
  const h = setup("setup");
  await act(() => h.dock.refresh());
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(
    screen.queryByRole("button", { name: "Allow notifications and badges" }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Set up Dock badges" }));
  expect(h.permission.mock.calls).toEqual([[false], [true]]);
});
it.each([
  [true, "Win32"],
  [true, "Linux x86_64"],
  [true, ""],
  [false, "MacIntel"],
] as const)(
  "hides Dock settings and makes no IPC calls for native=%s platform=%s",
  async (tauri, platform) => {
    native.value = tauri;
    vi.stubGlobal("navigator", { platform });
    const indicator = createUnreadIndicator();
    cleanups.push(indicator.dispose);
    const { container } = render(
      <UnreadIndicatorSettings indicator={indicator} />,
    );
    await act(async () => {
      indicator.setUnread(true);
      await indicator.refresh();
      await indicator.request();
      await indicator.dispose();
    });
    expect(container).toBeEmptyDOMElement();
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("shows a Dock write error and retries through the existing permission check", async () => {
  const set = vi.fn(async (_unread: boolean) => {});
  const indicator = createUnreadIndicator({
    permission: async () => "enabled",
    set,
  });
  cleanups.push(indicator.dispose);
  render(<UnreadIndicatorSettings indicator={indicator} />);
  await act(() => indicator.refresh());
  set.mockRejectedValueOnce(new Error("Dock unavailable"));
  await act(async () => {
    indicator.setUnread(true);
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Dock unavailable",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check Dock permission" }));
  expect(set).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
