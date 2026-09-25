// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserHostView } from "./BrowserHostView";
import type { BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

class TestResizeObserver {
  static callbacks: Array<() => void> = [];
  constructor(callback: () => void) {
    TestResizeObserver.callbacks.push(callback);
  }
  observe() {}
  disconnect() {}
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakePlatform(): BrowserPlatform {
  return {
    available: true,
    attach: vi.fn(async () => "session-1"),
    setBounds: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    action: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      loading: false,
      error: null,
    })),
    detach: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  TestResizeObserver.callbacks = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 410,
    bottom: 320,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("attaches hidden-first guest bounds and detaches on close", async () => {
  const platform = fakePlatform();
  const view = render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenCalledWith(
      "session-1",
      { x: 10, y: 20, width: 400, height: 300 },
      true,
    ),
  );
  view.unmount();
  await waitFor(() =>
    expect(platform.detach).toHaveBeenCalledWith("session-1"),
  );
});

it("detaches a late attach result and serializes its replacement", async () => {
  const first = deferred<string>();
  const platform = fakePlatform();
  vi.mocked(platform.attach)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce("session-2");
  const sessions = new BrowserSessions(platform);
  const view = render(
    <BrowserHostView
      url="https://one.example"
      platform={platform}
      sessions={sessions}
    />,
  );
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
  view.rerender(
    <BrowserHostView
      url="https://two.example"
      platform={platform}
      sessions={sessions}
    />,
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);
  first.resolve("session-1");
  await waitFor(() =>
    expect(platform.detach).toHaveBeenCalledWith("session-1"),
  );
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  expect(
    vi.mocked(platform.detach).mock.invocationCallOrder[0] ?? 0,
  ).toBeLessThan(vi.mocked(platform.attach).mock.invocationCallOrder[1] ?? 0);
  view.unmount();
});

it("forces a bounds update on window resize even when geometry is unchanged", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
});

it("hides with the last valid bounds when the viewport leaves the window", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    x: 1200,
    y: 20,
    left: 1200,
    top: 20,
    right: 1600,
    bottom: 320,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  fireEvent.scroll(window);
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
  expect(platform.setBounds).toHaveBeenLastCalledWith(
    "session-1",
    { x: 10, y: 20, width: 400, height: 300 },
    false,
  );
});

it("waits for positive viewport bounds before attaching", async () => {
  const platform = fakePlatform();
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValueOnce({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  expect(platform.attach).not.toHaveBeenCalled();
  TestResizeObserver.callbacks[0]?.();
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
});

it("hides when an already-open modal is inserted and shows after removal", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  dialog.remove();
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
});

it("hides for host popups marked after the browser is attached", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const popup = document.createElement("nav");
  document.body.append(popup);
  popup.setAttribute("data-popup-open", "");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  popup.removeAttribute("data-popup-open");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
  popup.remove();
});

it("serializes presentation writes and applies the newest visibility", async () => {
  const firstWrite = deferred<void>();
  const platform = fakePlatform();
  vi.mocked(platform.setBounds)
    .mockImplementationOnce(() => firstWrite.promise)
    .mockResolvedValue(undefined);
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(platform.setBounds).toHaveBeenCalledTimes(1);
  firstWrite.resolve();
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
  expect(platform.setBounds).toHaveBeenLastCalledWith(
    "session-1",
    expect.any(Object),
    false,
  );
  dialog.remove();
});

it("renders attach failures in toolbar space outside native guest bounds", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.attach).mockRejectedValue(
    new Error("Native browser unavailable"),
  );
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Native browser unavailable");
  expect(alert.parentElement).toHaveAttribute("aria-label", "Browser");
});

it("routes address and navigation controls to the active session", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  const address = screen.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "https://other.example{Enter}");
  await user.click(screen.getByLabelText("Back"));
  await user.click(screen.getByLabelText("Forward"));
  await user.click(screen.getByLabelText("Reload"));
  expect(platform.navigate).toHaveBeenCalledWith(
    "session-1",
    "https://other.example",
  );
  expect(platform.action).toHaveBeenCalledWith("session-1", "back");
  expect(platform.action).toHaveBeenCalledWith("session-1", "forward");
  expect(platform.action).toHaveBeenCalledWith("session-1", "reload");
});

it("keeps Reload keyboard-accessible while the website is loading", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "Loading page",
    loading: true,
    error: null,
  });
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await screen.findByTitle("Loading page");
  await user.tab();
  expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Forward" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reload" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(platform.action).toHaveBeenCalledWith("session-1", "reload");
});

it("shows a synchronous address validation error", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.navigate).mockImplementation(() => {
    throw new Error("Only http and https URLs are supported");
  });
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.status).toHaveBeenCalled());
  const address = screen.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "file:///etc/passwd{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only http and https URLs are supported",
  );
  vi.mocked(platform.navigate).mockRejectedValueOnce(
    new Error("Navigation denied"),
  );
  await user.clear(address);
  await user.type(address, "https://blocked.example{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Navigation denied"),
  );
});

it("ignores status from a replaced session", async () => {
  const oldStatus = deferred<{
    url: string;
    title: string;
    loading: boolean;
    error: null;
  }>();
  const platform = fakePlatform();
  vi.mocked(platform.attach)
    .mockResolvedValueOnce("session-1")
    .mockResolvedValueOnce("session-2");
  vi.mocked(platform.status)
    .mockImplementationOnce(() => oldStatus.promise)
    .mockResolvedValueOnce({
      url: "https://new.example/",
      title: "New page",
      loading: false,
      error: null,
    });
  const sessions = new BrowserSessions(platform);
  const view = render(
    <BrowserHostView
      url="https://old.example"
      platform={platform}
      sessions={sessions}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  view.rerender(
    <BrowserHostView
      url="https://new.example"
      platform={platform}
      sessions={sessions}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-2"),
  );
  oldStatus.resolve({
    url: "https://old.example/",
    title: "Old page",
    loading: false,
    error: null,
  });
  await waitFor(() => expect(screen.getByTitle("New page")).toBeVisible());
  expect(screen.queryByText("Old page")).not.toBeInTheDocument();
});
