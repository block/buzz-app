import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  BACKGROUND_UPDATE_CHECK_INTERVAL_MS,
  createUpdates,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  type UpdateHandle,
  type UpdatePlatform,
  type Updates,
} from "./updates";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handle(version = "1.2.3") {
  const download = deferred();
  const install = deferred();
  const update: UpdateHandle & {
    download: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } = {
    version,
    download: vi.fn(() => download.promise),
    install: vi.fn(() => install.promise),
    close: vi.fn(async () => {}),
  };
  return { update, download, install };
}

let checks: ReturnType<typeof deferred<UpdateHandle | null>>[];
let platform: UpdatePlatform & {
  check: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
};
let updates: Updates | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  checks = [];
  platform = {
    desktop: true,
    check: vi.fn(() => {
      const check = deferred<UpdateHandle | null>();
      checks.push(check);
      return check.promise;
    }),
    relaunch: vi.fn(async () => {}),
  };
});

afterEach(() => {
  updates?.dispose();
  updates = undefined;
  vi.useRealTimers();
});

const start = () => {
  updates = createUpdates(platform);
  return updates;
};
const state = () => updates?.snapshot().state;
/** The native check starts after the previous handle is released. */
async function check(index: number) {
  // Flush microtasks only: fake-timer vi.waitFor would also advance the clock.
  for (let i = 0; i < 10 && !checks[index]; i++) await Promise.resolve();
  const pending = checks[index];
  if (!pending) throw new Error(`Update check ${index} did not start`);
  return pending;
}

it("downloads a background update, offers restart, then installs and relaunches", async () => {
  const updates = start();
  expect(state()).toBe("idle");
  const { update, download, install } = handle();
  (await check(0)).resolve(update);
  await vi.waitFor(() => expect(state()).toBe("downloading"));
  // The native download carries its own deadline; the check's does not apply.
  expect(update.download).toHaveBeenCalledWith(expect.any(Function), {
    timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
  });
  download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));

  const installing = updates.installAndRelaunch();
  expect(state()).toBe("installing");
  void updates.installAndRelaunch();
  expect(update.install).toHaveBeenCalledOnce();
  install.resolve();
  await installing;
  expect(platform.relaunch).toHaveBeenCalledOnce();
});

it("reports a refused restart and stays running", async () => {
  platform.relaunch.mockRejectedValueOnce(
    "Agent shutdown incomplete; restart Buzz to finish the update: busy",
  );
  const updates = start();
  const { update, download, install } = handle();
  (await check(0)).resolve(update);
  download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));
  install.resolve();
  await updates.installAndRelaunch();
  expect(updates.snapshot()).toEqual({
    state: "error",
    message:
      "Agent shutdown incomplete; restart Buzz to finish the update: busy",
  });
});

it("keeps quiet background results out of status but reports manual ones", async () => {
  const updates = start();
  const background = await check(0);
  background.resolve(null);
  await vi.advanceTimersByTimeAsync(0);
  expect(state()).toBe("idle");

  const manual = updates.checkForUpdate();
  (await check(1)).resolve(null);
  await manual;
  expect(state()).toBe("up-to-date");

  const failing = updates.checkForUpdate();
  (await check(2)).reject(new Error("network down"));
  await failing;
  expect(updates.snapshot()).toEqual({
    state: "error",
    message: "network down",
  });
});

it("surfaces a manual check requested while a background check is in flight", async () => {
  const updates = start();
  const background = await check(0);
  void updates.checkForUpdate();
  expect(state()).toBe("checking");
  background.resolve(null);
  await vi.waitFor(() => expect(state()).toBe("up-to-date"));
});

it("reports builds without the native updater as unavailable", async () => {
  const updates = start();
  (await check(0)).reject("plugin updater not found");
  await vi.advanceTimersByTimeAsync(0);
  expect(state()).toBe("idle");
  const manual = updates.checkForUpdate();
  (await check(1)).reject(new Error("plugin updater not found"));
  await manual;
  expect(state()).toBe("unavailable");
});

it("does not reach the native updater outside the desktop app", async () => {
  platform.desktop = false;
  const updates = start();
  await updates.checkForUpdate();
  expect(state()).toBe("unavailable");
  expect(platform.check).not.toHaveBeenCalled();
});

it("repeats background checks on the interval unless an update is in progress", async () => {
  start();
  (await check(0)).resolve(null);
  await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_INTERVAL_MS - 1);
  expect(platform.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(platform.check).toHaveBeenCalledTimes(2);

  const { update, download } = handle();
  (await check(1)).resolve(update);
  download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));
  await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_INTERVAL_MS);
  expect(platform.check).toHaveBeenCalledTimes(2);
  expect(update.close).not.toHaveBeenCalled();
});

it("reports download and install failures, then retries with a fresh check", async () => {
  const updates = start();
  const first = handle();
  (await check(0)).resolve(first.update);
  await vi.waitFor(() => expect(state()).toBe("downloading"));
  first.download.reject(new Error("download interrupted"));
  await vi.waitFor(() =>
    expect(updates.snapshot()).toEqual({
      state: "error",
      message: "download interrupted",
    }),
  );

  const retry = updates.checkForUpdate();
  expect(first.update.close).toHaveBeenCalledOnce();
  const second = handle("1.2.4");
  (await check(1)).resolve(second.update);
  await retry;
  second.download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));

  const installing = updates.installAndRelaunch();
  second.install.reject(new Error("signature mismatch"));
  await installing;
  expect(updates.snapshot()).toEqual({
    state: "error",
    message: "signature mismatch",
  });
  expect(platform.relaunch).not.toHaveBeenCalled();

  // A failed install keeps the handle; errors do not block the next background check.
  await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_INTERVAL_MS);
  expect(platform.check).toHaveBeenCalledTimes(3);
  expect(second.update.close).toHaveBeenCalledOnce();
});

it("stops background checks on dispose without closing an in-flight download", async () => {
  const updates = start();
  const { update } = handle();
  (await check(0)).resolve(update);
  await vi.waitFor(() => expect(state()).toBe("downloading"));
  updates.dispose();
  // An in-flight download keeps its handle until it settles.
  expect(update.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_INTERVAL_MS);
  expect(platform.check).toHaveBeenCalledOnce();
});

it.each([
  { name: "mid-download", contentLength: 100, received: 50 },
  { name: "after the final chunk", contentLength: 100, received: 100 },
  { name: "with unknown size", contentLength: undefined, received: 50 },
])(
  "keeps a download dismissed $name through completion",
  async ({ contentLength, received }) => {
    const updates = start();
    const { update, download } = handle();
    let report!: (event: DownloadEvent) => void;
    update.download.mockImplementation((onEvent: typeof report) => {
      report = onEvent;
      return download.promise;
    });
    // Join the startup check so this download has a visible, dismissible notice.
    await updates.checkForUpdate();
    (await check(0)).resolve(update);
    try {
      await vi.waitFor(() => expect(state()).toBe("downloading"));
      report({
        event: "Started",
        data: contentLength === undefined ? {} : { contentLength },
      });
      report({ event: "Progress", data: { chunkLength: received } });
      updates.dismissNotice();
      if (received < 100)
        report({ event: "Progress", data: { chunkLength: 100 - received } });
      report({ event: "Finished" });
      download.resolve();
      await vi.waitFor(() => expect(state()).toBe("ready"));
      expect(updates.noticeDismissed()).toBe(true);
      expect(updates.noticePinned()).toBe(false);
    } finally {
      download.resolve();
    }
  },
);
