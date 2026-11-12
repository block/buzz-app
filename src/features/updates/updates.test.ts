import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type AgentWork,
  BACKGROUND_UPDATE_CHECK_INTERVAL_MS,
  createUpdates,
  IDLE_QUIET_MS,
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

const start = (work?: AgentWork) => {
  updates = createUpdates(platform, work);
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
  expect(update.download).toHaveBeenCalledWith(undefined, {
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

/** Local agents with `count` working; `set` reports a change as the runners do. */
function agentWork(count = 0) {
  const listeners = new Set<() => void>();
  return {
    isWorking: () => count > 0,
    workingCount: () => count,
    subscribeWorking(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: number) {
      count = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

/** An update downloaded and offered, with `work` wired in. */
async function readyWith(work: AgentWork) {
  const updates = start(work);
  const downloaded = handle();
  (await check(0)).resolve(downloaded.update);
  downloaded.download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));
  return { updates, ...downloaded };
}

it("installs once agents have been idle for the quiet period", async () => {
  const { updates, update, install } = await readyWith(agentWork());
  expect(updates.idleOptionAvailable()).toBe(true);
  updates.installWhenIdle();
  expect(state()).toBe("scheduled");
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS - 1);
  expect(update.install).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(state()).toBe("installing");
  expect(update.install).toHaveBeenCalledOnce();
  install.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(platform.relaunch).toHaveBeenCalledOnce();
});

it("waits while agents work and starts the quiet period over on each change", async () => {
  const work = agentWork(2);
  const { updates, update } = await readyWith(work);
  updates.installWhenIdle();
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS * 3);
  expect(update.install).not.toHaveBeenCalled();
  work.set(0);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS - 1);
  // A new turn in the quiet period cancels it.
  work.set(1);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).not.toHaveBeenCalled();
  expect(state()).toBe("scheduled");
  work.set(0);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).toHaveBeenCalledOnce();
});

it("checks again that agents are idle when the quiet period ends", async () => {
  const work = agentWork();
  const { updates, update } = await readyWith(work);
  updates.installWhenIdle();
  // A turn whose start has not been reported yet.
  const isWorking = vi.spyOn(work, "isWorking").mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).not.toHaveBeenCalled();
  expect(state()).toBe("scheduled");
  isWorking.mockRestore();
  work.set(1);
  work.set(0);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).toHaveBeenCalledOnce();
});

it("installs at once on Update now while scheduled, without a second install", async () => {
  const work = agentWork(1);
  const { updates, update } = await readyWith(work);
  updates.installWhenIdle();
  void updates.installAndRelaunch();
  expect(state()).toBe("installing");
  work.set(0);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).toHaveBeenCalledOnce();
  expect(work.listeners.size).toBe(1);
});

it("returns to ready on cancel and stops waiting", async () => {
  const { updates, update } = await readyWith(agentWork());
  updates.installWhenIdle();
  updates.cancelScheduled();
  expect(state()).toBe("ready");
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).not.toHaveBeenCalled();
});

it("keeps the schedule when its notice is dismissed", async () => {
  const { updates, update } = await readyWith(agentWork());
  updates.installWhenIdle();
  updates.dismissNotice();
  expect(updates.noticeDismissed()).toBe(true);
  await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS);
  expect(update.install).toHaveBeenCalledOnce();
});

it("skips background checks while scheduled", async () => {
  const { updates, update } = await readyWith(agentWork(1));
  updates.installWhenIdle();
  await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_INTERVAL_MS);
  expect(platform.check).toHaveBeenCalledOnce();
  expect(update.close).not.toHaveBeenCalled();
  expect(state()).toBe("scheduled");
});

it("reports agent work changes to its subscribers for the notice's count", async () => {
  const work = agentWork();
  const { updates } = await readyWith(work);
  const listener = vi.fn();
  updates.subscribe(listener);
  work.set(2);
  expect(listener).toHaveBeenCalledOnce();
  expect(updates.workingCount()).toBe(2);
  updates.dispose();
  expect(work.listeners.size).toBe(0);
});

it("offers no idle install without agent work", async () => {
  const updates = start();
  const { update, download } = handle();
  (await check(0)).resolve(update);
  download.resolve();
  await vi.waitFor(() => expect(state()).toBe("ready"));
  expect(updates.idleOptionAvailable()).toBe(false);
  expect(updates.workingCount()).toBe(0);
  updates.installWhenIdle();
  expect(state()).toBe("ready");
});
