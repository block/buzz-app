import { expect, it, vi } from "vitest";
import type { BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function platform(): BrowserPlatform {
  return {
    available: true,
    attach: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(async () => {}),
  };
}

const bounds = { x: 0, y: 0, width: 100, height: 100 };

it("does not attach a queued view that was disposed while waiting", async () => {
  const first = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => first.promise);
  const sessions = new BrowserSessions(browserPlatform);
  const active = sessions.attach("https://one.example", bounds, () => true);
  let queuedCurrent = true;
  const queued = sessions.attach(
    "https://two.example",
    bounds,
    () => queuedCurrent,
  );
  queuedCurrent = false;
  first.resolve("session-1");
  await expect(active).resolves.toBe("session-1");
  await expect(queued).resolves.toBeUndefined();
  expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
});

it("detaches an attach result whose view was disposed in flight", async () => {
  const attached = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => attached.promise);
  const sessions = new BrowserSessions(browserPlatform);
  let current = true;
  const result = sessions.attach("https://example.com", bounds, () => current);
  await vi.waitFor(() =>
    expect(browserPlatform.attach).toHaveBeenCalledTimes(1),
  );
  current = false;
  attached.resolve("session-1");
  await expect(result).resolves.toBeUndefined();
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
});
