import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as React from "react";
import {
  createPluginManager,
  type PluginManager,
  type BundledPlugin,
} from "./manager";
import { PagesService } from "../features/pages/service";
import type { PluginStorage } from "./storage";
import type { StorageResult } from "./types";

const ready = (enabled = true, paused = false): StorageResult => ({
  status: "ready",
  externalPluginsPaused: paused,
  catalog: {
    profile: "test",
    location: "test",
    plugins: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        source: paused ? "external" : "bundled",
        enabled,
        revision: "one",
        previous: null,
        reloadable: paused,
        error: null,
      },
    ],
  },
});
const managers: PluginManager[] = [];
const roots: Context[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function harness(
  overrides: Partial<PluginStorage> = {},
  fail: boolean | (() => boolean) = false,
  builtIn: readonly BundledPlugin[] = [],
) {
  const installation: PluginStorage = {
    getCatalog: vi.fn(async () => ready()),
    changePlugin: vi.fn(async () => ready(false)),
    recoverSettings: vi.fn(async () => ready()),
    readModule: vi.fn(async () => ""),
    reloadPlugin: vi.fn(async () => ready(false)),
    retryCredentialCleanup: vi.fn(async () => ({ pending: 0, running: 0 })),
    ...overrides,
  };
  const root = new Context();
  roots.push(root);
  const plugins = createPluginManager(root, {
    storage: installation,
    builtIn,
    bundled: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        module: {
          inject: ["pages"],
          apply(ctx) {
            if (typeof fail === "function" ? fail() : fail)
              throw new Error("Activation failed");
            ctx.pages.register({
              id: "main",
              title: "Main",
              component: () => null,
            });
          },
        },
      },
    ],
  });
  const pages = new PagesService(root);
  managers.push(plugins);
  return { plugins, pages, installation, root };
}
function deferred() {
  let resolve!: (result: StorageResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<StorageResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("runs host contributions while optional storage is pending and in recovery", async () => {
  const pending = deferred();
  const { plugins, pages } = harness(
    { getCatalog: () => pending.promise },
    false,
    [
      {
        manifest: { id: "host.feature", name: "Host feature", apiVersion: 1 },
        module: {
          inject: ["pages"],
          apply(ctx) {
            ctx.pages.register({
              id: "main",
              title: "Host",
              component: () => null,
            });
          },
        },
      },
    ],
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("loading");
  expect(pages.snapshot().map(({ key }) => key)).toEqual(["host.feature/main"]);
  pending.resolve({
    status: "recovery",
    reason: "Storage unavailable",
    canReset: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("recovery");
  expect(pages.snapshot().map(({ key }) => key)).toEqual(["host.feature/main"]);
  await plugins.dispose();
  expect(pages.snapshot()).toEqual([]);
});

it("keeps startup unsettled until the catalog is read and its plugins start", async () => {
  const pending = deferred();
  const { root, pages } = harness({ getCatalog: () => pending.promise });
  await vi.advanceTimersByTimeAsync(0);
  expect(root.pluginStatus.settled?.()).toBe(false);
  pending.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(pages.snapshot()).toHaveLength(1);
  expect(root.pluginStatus.settled?.()).toBe(true);
});
it("keeps startup unsettled while a failed catalog read retries, but not in recovery the user must act on", async () => {
  const { root, pages } = harness({
    getCatalog: vi
      .fn<PluginStorage["getCatalog"]>()
      .mockRejectedValueOnce(new Error("Storage offline"))
      .mockResolvedValue({
        status: "recovery",
        reason: "Unreadable settings",
        canReset: true,
      }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(root.pluginStatus.settled?.()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(pages.snapshot()).toHaveLength(0);
  expect(root.pluginStatus.settled?.()).toBe(true);
});
it("activates and observes CLI changes without any React subscribers", async () => {
  const { plugins, pages, installation } = harness();
  expect(plugins.startup()).toBe("loading");
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("ready");
  expect(pages.snapshot()).toHaveLength(1);
  const snapshot = plugins.snapshot();
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot()).toBe(snapshot);
  vi.mocked(installation.getCatalog).mockResolvedValue(ready(false));
  await vi.advanceTimersByTimeAsync(1000);
  expect(pages.snapshot()).toHaveLength(0);
});
it("publishes the managed policy beside the catalog and follows its changes without activating anything", async () => {
  const entry = {
    id: "example.managed",
    repository: "https://example.com/plugins",
    reference: "v1",
    commit: "0".repeat(40),
    path: ".",
  };
  const managed = (state: "missing" | "outdated"): StorageResult => ({
    ...(ready() as Extract<StorageResult, { status: "ready" }>),
    managed: {
      status: "ready",
      path: "/managed-plugins.json",
      source: "Example Org",
      plugins: [{ ...entry, state }],
      problems: [],
    },
  });
  const { plugins, pages, installation } = harness({
    getCatalog: vi.fn(async () => managed("missing")),
  });
  await vi.advanceTimersByTimeAsync(0);
  const configuration = () => plugins.snapshot().configuration;
  expect(configuration()).toMatchObject({
    managed: { plugins: [{ id: "example.managed", state: "missing" }] },
  });
  expect(pages.snapshot()).toHaveLength(1);
  const settled = plugins.snapshot();
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot()).toBe(settled);
  vi.mocked(installation.getCatalog).mockResolvedValue(managed("outdated"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(configuration()).toMatchObject({
    managed: { plugins: [{ state: "outdated" }] },
  });
  vi.mocked(installation.getCatalog).mockResolvedValue(ready());
  await vi.advanceTimersByTimeAsync(1000);
  expect(configuration()).not.toHaveProperty("managed");
  expect(installation.changePlugin).not.toHaveBeenCalled();
});
it("ignores a stale poll after a management change", async () => {
  const { plugins, pages, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  const poll = deferred();
  vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(1000);
  await plugins.change("disable", "example");
  poll.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(pages.snapshot()).toHaveLength(0);
  expect(plugins.snapshot().configuration).toEqual(ready(false));
});
it("keeps the last usable configuration on refresh failure", async () => {
  const { plugins, pages, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(installation.getCatalog).mockRejectedValue(
    new Error("Storage offline"),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.startup()).toBe("ready");
  expect(pages.snapshot()).toHaveLength(1);
  expect(plugins.snapshot().refreshError).toContain("Storage offline");
});
it("bounds startup reads, permits recovery, and ignores the late read", async () => {
  const initial = deferred();
  const { plugins } = harness({ getCatalog: () => initial.promise });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(plugins.startup()).toBe("recovery");
  await plugins.recover();
  initial.resolve(ready(false));
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready());
});
it("prevents overlapping edits and exposes their failure without dropping configuration", async () => {
  const change = vi.fn(async () => {
    throw new Error("Write failed");
  });
  const { plugins } = harness({ changePlugin: change });
  await vi.advanceTimersByTimeAsync(0);
  const first = plugins.change("disable", "example");
  await plugins.change("enable", "example");
  await first;
  expect(change).toHaveBeenCalledTimes(1);
  expect(plugins.snapshot().error).toContain("Write failed");
  expect(plugins.startup()).toBe("ready");
  expect(plugins.snapshot().busy).toBe(false);
  plugins.dismissError();
  expect(plugins.snapshot().error).toBeNull();
});
it.each(["resolve", "reject"] as const)(
  "does not replace a timed-out catalog read until it actually %ss",
  async (settlement) => {
    const pending = deferred();
    const getCatalog = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ready());
    const { plugins } = harness({ getCatalog });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plugins.startup()).toBe("recovery");
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await plugins.retry()).toBe(false);
    expect(plugins.snapshot().error).toContain("still in progress");
    expect(getCatalog).toHaveBeenCalledTimes(1);
    if (settlement === "resolve") pending.resolve(ready(false));
    else pending.reject(new Error("Late native failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.startup()).toBe("recovery");
    await vi.advanceTimersByTimeAsync(1000);
    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(plugins.snapshot().configuration).toEqual(ready());
  },
);
it.each(["resolve", "reject"] as const)(
  "keeps a timed-out edit busy until it actually %ss, then refreshes",
  async (settlement) => {
    const pending = deferred();
    const changePlugin = vi.fn(() => pending.promise);
    const { plugins, installation } = harness({ changePlugin });
    await vi.advanceTimersByTimeAsync(0);
    const update = plugins.change("disable", "example");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await update).toBe(false);
    expect(plugins.snapshot().error).toContain("10 seconds");
    expect(plugins.snapshot().busy).toBe(true);
    expect(await plugins.change("enable", "example")).toBe(false);
    expect(await plugins.recover()).toBe(false);
    await vi.advanceTimersByTimeAsync(33_000);
    expect(changePlugin).toHaveBeenCalledTimes(1);
    expect(installation.recoverSettings).not.toHaveBeenCalled();
    // Fake timers fire the t=0 watchdog before the t=9s poll due at t=10s:
    // startup + 34 reads from t=10s through t=43s, never another edit.
    expect(installation.getCatalog).toHaveBeenCalledTimes(35);
    if (settlement === "resolve") pending.resolve(ready(false));
    else pending.reject(new Error("Late write failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.snapshot().busy).toBe(false);
    // Neither late success nor failure may replace the displayed configuration.
    expect(plugins.snapshot().configuration).toEqual(ready());
    vi.mocked(installation.getCatalog).mockResolvedValue(ready(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(plugins.snapshot().configuration).toEqual(ready(false));
    expect(installation.getCatalog).toHaveBeenCalledTimes(36);
  },
);
it("does not publish a timed-out edit's settlement after disposal", async () => {
  const pending = deferred();
  const { plugins, installation } = harness({
    changePlugin: () => pending.promise,
  });
  await vi.advanceTimersByTimeAsync(0);
  const update = plugins.change("disable", "example");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await update).toBe(false);
  const listener = vi.fn();
  plugins.subscribe(listener);
  expect(installation.getCatalog).toHaveBeenCalledTimes(2);
  await plugins.dispose();
  pending.reject(new Error("Late write failure"));
  await vi.advanceTimersByTimeAsync(33_000);
  expect(listener).not.toHaveBeenCalled();
  expect(installation.getCatalog).toHaveBeenCalledTimes(2);
});
it("keeps an edit busy through configuration publication", async () => {
  const { plugins, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  let reentered = false;
  plugins.subscribe(() => {
    if (!plugins.snapshot().busy && !reentered) {
      reentered = true;
      expect(plugins.snapshot().configuration).toEqual(ready(false));
      void plugins.change("enable", "example");
    }
  });
  expect(await plugins.change("disable", "example")).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reentered).toBe(true);
  expect(installation.changePlugin).toHaveBeenCalledTimes(2);
});
it("keeps safe-mode configuration enabled while skipping external activation", async () => {
  const { plugins, pages } = harness({
    getCatalog: async () => ready(true, true),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("ready");
  expect(plugins.snapshot().configuration).toEqual(ready(true, true));
  expect(pages.snapshot()).toHaveLength(0);
});
it("exposes activation failure separately from stored configuration", async () => {
  const { plugins, pages } = harness({}, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready());
  expect(plugins.snapshot().activation.example?.error).toContain(
    "Activation failed",
  );
  expect(pages.snapshot()).toHaveLength(0);
});
it("stops polling and ignores pending reads on disposal", async () => {
  const pending = deferred();
  const { plugins, installation, pages } = harness({
    getCatalog: vi.fn(() => pending.promise),
  });
  const listener = vi.fn();
  plugins.subscribe(listener);
  await plugins.dispose();
  pending.resolve(ready());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(listener).not.toHaveBeenCalled();
  expect(installation.getCatalog).toHaveBeenCalledTimes(1);
  expect(pages.snapshot()).toHaveLength(0);
});

it("disposing plugins leaves app-owned Cordis services alive", async () => {
  const { plugins, pages, root } = harness();
  const sharedCleanup = vi.fn();
  root.effect(() => sharedCleanup);
  await vi.advanceTimersByTimeAsync(0);
  expect(pages.snapshot()).toHaveLength(1);
  await plugins.dispose();
  expect(pages.snapshot()).toHaveLength(0);
  expect(sharedCleanup).not.toHaveBeenCalled();
  await root.fiber.dispose();
  expect(sharedCleanup).toHaveBeenCalledTimes(1);
});

it("provides the host React instance through Cordis", async () => {
  const { root } = harness();
  let received: unknown;
  const consumer = root.plugin({
    inject: ["react"],
    apply(ctx) {
      received = ctx.react;
    },
  });
  await consumer.await();
  expect(received).toBe(React);
});

it("defaults to platform storage using the bundled manifests", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const root = new Context();
  roots.push(root);
  const plugins = createPluginManager(root, {
    bundled: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        module: { apply() {} },
      },
    ],
  });
  managers.push(plugins);
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toMatchObject({
    status: "ready",
    catalog: { plugins: [{ manifest: { id: "example" }, enabled: true }] },
  });
  expect(plugins.snapshot().activation.example?.status).toBe("active");
  await plugins.change("disable", "example");
  expect(plugins.snapshot().activation.example).toBeUndefined();
  expect(values.get("buzzodz.plugins.v1")).toContain('"example":false');
});

it.each(["resolve", "reject"] as const)(
  "retains a confirmed import past its watchdog until it %ss, rejecting overlap and stale polls",
  async (settlement) => {
    const install = deferred();
    const imports = {
      checkFolder: vi.fn(async () => ({ revision: "updated" })),
      previewFolder: vi.fn(async () => null),
      folder: vi.fn(async () => null),
      files: vi.fn(async () => null),
      git: vi.fn(async () => null),
      url: vi.fn(async () => null),
      checkGit: vi.fn(async () => null),
      discard: vi.fn(async () => {}),
      install: vi.fn(() => install.promise),
    };
    const { plugins, installation } = harness({ imports });
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.imports).toBe(imports);
    const poll = deferred();
    vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const first = plugins.installImport("preview", "nested/dist");
    const returned = vi.fn();
    void first.then(returned);
    expect(await plugins.installImport("other", "wrong")).toBe(false);
    expect(imports.install).toHaveBeenCalledExactlyOnceWith(
      "preview",
      "nested/dist",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plugins.snapshot().error).toContain("10 seconds");
    expect(plugins.snapshot().busy).toBe(true);
    expect(returned).not.toHaveBeenCalled();
    expect(await plugins.installImport("other", "wrong")).toBe(false);
    if (settlement === "resolve") install.resolve(ready(false));
    else install.reject(new Error("Late native failure"));
    expect(await first).toBe(settlement === "resolve");
    expect(plugins.snapshot().busy).toBe(false);
    expect(plugins.snapshot().error).toBe(
      settlement === "resolve" ? null : "Error: Late native failure",
    );
    poll.resolve(ready());
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.snapshot().configuration).toEqual(
      ready(settlement !== "resolve"),
    );
  },
);

it("reloads through the management boundary, rejecting overlap and stale polls", async () => {
  const reload = deferred();
  const { plugins, installation } = harness({
    reloadPlugin: vi.fn(() => reload.promise),
  });
  await vi.advanceTimersByTimeAsync(0);
  const poll = deferred();
  vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(1000);
  const first = plugins.reload("example");
  expect(await plugins.reload("other")).toBe(false);
  expect(installation.reloadPlugin).toHaveBeenCalledExactlyOnceWith("example");
  reload.resolve(ready(false));
  expect(await first).toBe(true);
  poll.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready(false));
});

it("retries only failed activation of the installed revision without storage writes or acquisition", async () => {
  const shouldFail = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const { plugins, installation, pages } = harness({}, shouldFail);
  expect(plugins.retryPlugin("example")).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  const configuration = plugins.snapshot().configuration;
  expect(plugins.snapshot().activation.example?.status).toBe("failed");
  expect(plugins.retryPlugin("missing")).toBe(false);
  expect(plugins.retryPlugin("example")).toBe(true);
  expect(plugins.snapshot().activation.example?.status).toBe("starting");
  expect(plugins.retryPlugin("example")).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().activation.example?.status).toBe("active");
  expect(plugins.snapshot().configuration).toBe(configuration);
  expect(pages.snapshot()).toHaveLength(1);
  expect(shouldFail).toHaveBeenCalledTimes(2);
  expect(installation.getCatalog).toHaveBeenCalledTimes(1);
  expect(installation.readModule).not.toHaveBeenCalled();
  expect(installation.changePlugin).not.toHaveBeenCalled();
  expect(installation.reloadPlugin).not.toHaveBeenCalled();
  expect(plugins.retryPlugin("example")).toBe(false);
  await plugins.dispose();
  expect(plugins.retryPlugin("example")).toBe(false);
});

it("rejects retry while busy, disabled, paused, or carrying an artifact error", async () => {
  const operation = deferred();
  const { plugins, installation } = harness(
    { changePlugin: vi.fn(() => operation.promise) },
    true,
  );
  await vi.advanceTimersByTimeAsync(0);
  const change = plugins.change("disable", "example");
  expect(plugins.retryPlugin("example")).toBe(false);
  operation.resolve(ready(false));
  await change;
  expect(plugins.retryPlugin("example")).toBe(false);
  vi.mocked(installation.getCatalog).mockResolvedValue(ready(true, true));
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.retryPlugin("example")).toBe(false);
  const broken = ready();
  if (broken.status !== "ready") throw new Error("Expected ready fixture");
  for (const plugin of broken.catalog.plugins)
    plugin.error = "Artifact unavailable";
  vi.mocked(installation.getCatalog).mockResolvedValue(broken);
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot().activation.example).toBeUndefined();
  expect(plugins.retryPlugin("example")).toBe(false);
});

it("does not load an enabled external plugin with a verification error", async () => {
  const catalog = ready();
  if (catalog.status !== "ready") throw new Error("fixture");
  const entry = catalog.catalog.plugins[0];
  if (!entry) throw new Error("fixture");
  entry.source = "external";
  entry.error = "External plugins require a signed release";
  const { plugins, installation } = harness({
    getCatalog: async () => catalog,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(installation.readModule).not.toHaveBeenCalled();
  expect(plugins.snapshot().activation.example).toBeUndefined();
  expect(plugins.retryPlugin("example")).toBe(false);
});

it("disposes an active plugin when its unchanged revision fails verification", async () => {
  const code = `export const inject = ["pages"];
export function apply(ctx) {
  ctx.pages.register({ id: "main", title: "External", component: () => null });
}`;
  const objectUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue(`data:text/javascript,${encodeURIComponent(code)}`);
  try {
    const catalog = ready();
    if (catalog.status !== "ready") throw new Error("fixture");
    const entry = catalog.catalog.plugins[0];
    if (!entry) throw new Error("fixture");
    entry.source = "external";
    const { plugins, pages, installation } = harness({
      getCatalog: vi.fn(async () => catalog),
      readModule: vi.fn(async () => code),
    });
    await vi.waitFor(() => expect(pages.snapshot()).toHaveLength(1));
    expect(plugins.snapshot().activation.example?.status).toBe("active");
    const broken = structuredClone(catalog);
    const brokenEntry = broken.catalog.plugins[0];
    if (!brokenEntry) throw new Error("fixture");
    brokenEntry.error = "Invalid plugin release event ID or signature";
    vi.mocked(installation.getCatalog).mockResolvedValue(broken);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pages.snapshot()).toHaveLength(0);
    expect(plugins.snapshot().activation.example).toBeUndefined();
    expect(plugins.retryPlugin("example")).toBe(false);
    expect(installation.readModule).toHaveBeenCalledTimes(1);
  } finally {
    objectUrl.mockRestore();
  }
});

it("loads an enabled external plugin regardless of its id", async () => {
  const catalog = ready();
  if (catalog.status !== "ready") throw new Error("fixture");
  const entry = catalog.catalog.plugins[0];
  if (!entry) throw new Error("fixture");
  entry.manifest = { id: "monitor", name: "Monitor", apiVersion: 1 };
  entry.source = "external";
  const { plugins, installation } = harness({
    getCatalog: async () => catalog,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("ready");
  expect(installation.readModule).toHaveBeenCalledWith("monitor", "one");
});

it("offers agents the plugins it reads, through the context", async () => {
  const { root } = harness();
  const agent = root.pluginRequests?.forAgent({ pubkey: "a", name: "A" });
  await expect(agent?.list()).rejects.toThrow("Plugin settings are not ready");
  await vi.advanceTimersByTimeAsync(0);
  expect(await agent?.list()).toMatchObject({
    plugins: [{ id: "example", enabled: true, bundled: true }],
  });
});
// Native cleanup summaries are authoritative catalog metadata, not renderer debt.
const cleanupCatalog = (
  pending = 2,
  running = 1,
  unreadable = false,
): StorageResult => {
  const result = ready();
  if (result.status !== "ready") throw new Error("fixture");
  return {
    ...result,
    catalog: {
      ...result.catalog,
      plugins: [],
      credentialCleanup: { pending, running, unreadable },
    },
  } as StorageResult;
};

it.each(["resolve", "reject"] as const)(
  "reconciles a lost remove reply while busy and ignores its late %s",
  async (settlement) => {
    const pending = deferred();
    const { plugins, pages, installation } = harness({
      changePlugin: () => pending.promise,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.snapshot()).toHaveLength(1);
    const update = plugins.change("remove", "example");
    vi.mocked(installation.getCatalog).mockResolvedValue(cleanupCatalog());
    await vi.advanceTimersByTimeAsync(9999);
    expect(installation.getCatalog).toHaveBeenCalledTimes(1);
    expect(await plugins.change("enable", "example")).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await update).toBe(false);
    expect(plugins.snapshot().busy).toBe(true);
    expect(pages.snapshot()).toHaveLength(0);
    expect(plugins.snapshot().configuration).toEqual(cleanupCatalog());
    vi.mocked(installation.getCatalog).mockResolvedValue(
      cleanupCatalog(0, 0, true),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const current = plugins.snapshot().configuration;
    const error = plugins.snapshot().error;
    if (settlement === "resolve") pending.resolve(ready());
    else pending.reject(new Error("stale removal failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.snapshot().busy).toBe(false);
    expect(plugins.snapshot().configuration).toBe(current);
    expect(plugins.snapshot().error).toBe(error);
    expect(pages.snapshot()).toHaveLength(0);
  },
);

it("publishes a committed removal and its safe problem before cleanup finishes", async () => {
  const saved = {
    ...cleanupCatalog(),
    committed: true,
    problem: "Plugin removed, but its files could not be deleted",
  };
  const { plugins, pages, installation } = harness({
    changePlugin: vi.fn(async () => saved),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(await plugins.change("remove", "example")).toBe(true);
  expect(plugins.snapshot().busy).toBe(false);
  expect(pages.snapshot()).toHaveLength(0);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog());
  expect(plugins.snapshot().error).toBe(saved.problem);
  vi.mocked(installation.getCatalog).mockResolvedValue(cleanupCatalog());
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog());
});

it("never accepts an explicitly uncommitted catalog as a successful edit", async () => {
  const { plugins, pages } = harness({
    changePlugin: async () => ({
      ...cleanupCatalog(),
      committed: false,
      problem: "Plugin change outcome is unknown",
    }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(await plugins.change("remove", "example")).toBe(false);
  expect(plugins.snapshot().configuration).toEqual(ready());
  expect(plugins.snapshot().error).toContain("unknown");
  expect(pages.snapshot()).toHaveLength(1);
});

it("retains row-independent pending/unknown across refresh and manager restart without retrying", async () => {
  const retryCredentialCleanup = vi.fn();
  const { plugins, pages } = harness({
    getCatalog: async () => cleanupCatalog(0, 0, true),
    retryCredentialCleanup,
  } as Partial<PluginStorage>);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pages.snapshot()).toHaveLength(0);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog(0, 0, true));
  await plugins.dispose();
  const restarted = harness({
    getCatalog: async () => cleanupCatalog(1, 0),
    retryCredentialCleanup,
  } as Partial<PluginStorage>);
  await vi.advanceTimersByTimeAsync(2000);
  expect(restarted.plugins.snapshot().configuration).toEqual(
    cleanupCatalog(1, 0),
  );
  expect(retryCredentialCleanup).not.toHaveBeenCalled();
});

it("dispatches one cleanup retry independently of edits/polls and trusts only catalog evidence", async () => {
  let release!: (value: { pending: number; running: number }) => void;
  const promise = new Promise<{ pending: number; running: number }>(
    (resolve) => {
      release = resolve;
    },
  );
  const retryCredentialCleanup = vi.fn(() => promise);
  const { plugins, installation } = harness({
    getCatalog: vi.fn(async () => cleanupCatalog(0, 0, true)),
    retryCredentialCleanup,
  } as Partial<PluginStorage>);
  await vi.advanceTimersByTimeAsync(0);
  const retry = plugins.retryCredentialCleanup();
  expect(await plugins.retryCredentialCleanup()).toBe(false);
  expect(plugins.snapshot().cleanupBusy).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.mocked(installation.getCatalog).mock.calls.length).toBeGreaterThan(
    1,
  );
  expect(await plugins.change("disable", "example")).toBe(true);
  vi.mocked(installation.getCatalog).mockResolvedValue(
    cleanupCatalog(0, 0, true),
  );
  await vi.advanceTimersByTimeAsync(1000);
  release({ pending: 0, running: 0 });
  expect(await retry).toBe(true);
  expect(retryCredentialCleanup).toHaveBeenCalledTimes(1);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog(0, 0, true));
  expect(plugins.snapshot().cleanupBusy).toBe(false);
  const reads = vi.mocked(installation.getCatalog).mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(installation.getCatalog).toHaveBeenCalledTimes(reads + 3);
  vi.mocked(installation.getCatalog).mockResolvedValue(cleanupCatalog(0, 0));
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog(0, 0));
});

it.each(["resolve", "reject"] as const)(
  "bounds retry wait without duplicate dispatch or late %s replacing newer state",
  async (settlement) => {
    let resolve!: (value: { pending: number; running: number }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ pending: number; running: number }>(
      (done, fail) => {
        resolve = done;
        reject = fail;
      },
    );
    const retryCredentialCleanup = vi.fn(() => pending);
    const { plugins, installation } = harness({
      getCatalog: vi.fn(async () => cleanupCatalog()),
      retryCredentialCleanup,
    } as Partial<PluginStorage>);
    await vi.advanceTimersByTimeAsync(0);
    const retry = plugins.retryCredentialCleanup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await retry).toBe(false);
    expect(plugins.snapshot().cleanupBusy).toBe(true);
    expect(plugins.snapshot().cleanupError).toContain("10 seconds");
    expect(await plugins.retryCredentialCleanup()).toBe(false);
    vi.mocked(installation.getCatalog).mockResolvedValue(
      cleanupCatalog(0, 0, true),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const configuration = plugins.snapshot().configuration;
    const error = plugins.snapshot().cleanupError;
    if (settlement === "resolve") resolve({ pending: 0, running: 0 });
    else reject(new Error("late cleanup failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.snapshot().cleanupBusy).toBe(false);
    expect(plugins.snapshot().configuration).toBe(configuration);
    expect(plugins.snapshot().cleanupError).toBe(error);
    expect(retryCredentialCleanup).toHaveBeenCalledTimes(1);
  },
);

it.each(["resolve", "reject"] as const)(
  "ignores cleanup %s after disposal without reads or publication",
  async (settlement) => {
    let resolve!: (value: { pending: number; running: number }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ pending: number; running: number }>(
      (done, fail) => {
        resolve = done;
        reject = fail;
      },
    );
    const retryCredentialCleanup = vi.fn(() => pending);
    const { plugins, installation } = harness({
      retryCredentialCleanup,
    } as Partial<PluginStorage>);
    await vi.advanceTimersByTimeAsync(0);
    const retry = plugins.retryCredentialCleanup();
    const listener = vi.fn();
    plugins.subscribe(listener);
    const reads = vi.mocked(installation.getCatalog).mock.calls.length;
    await plugins.dispose();
    if (settlement === "resolve") resolve({ pending: 0, running: 0 });
    else reject(new Error("disposed cleanup failure"));
    expect(await retry).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listener).not.toHaveBeenCalled();
    expect(installation.getCatalog).toHaveBeenCalledTimes(reads);
    expect(await plugins.retryCredentialCleanup()).toBe(false);
    expect(retryCredentialCleanup).toHaveBeenCalledTimes(1);
  },
);

it("updates cleanup metadata without restarting unchanged active plugins", async () => {
  const { plugins, pages, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  const activation = plugins.snapshot().activation.example;
  const contribution = pages.snapshot()[0];
  const result = ready();
  if (result.status !== "ready") throw new Error("fixture");
  vi.mocked(installation.getCatalog).mockResolvedValue({
    ...result,
    catalog: {
      ...result.catalog,
      credentialCleanup: { pending: 2, running: 1 },
    },
  } as StorageResult);
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot().activation.example).toBe(activation);
  expect(pages.snapshot()[0]).toBe(contribution);
  expect(plugins.snapshot().configuration).toMatchObject({
    catalog: { credentialCleanup: { pending: 2, running: 1 } },
  });
});

it("keeps cleanup errors separate from an edit's uncertain-outcome error", async () => {
  const edit = deferred();
  const retryCredentialCleanup = vi.fn(async () => {
    throw new Error("already running");
  });
  const { plugins } = harness({
    changePlugin: () => edit.promise,
    retryCredentialCleanup,
  } as Partial<PluginStorage>);
  await vi.advanceTimersByTimeAsync(0);
  const change = plugins.change("remove", "example");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await change).toBe(false);
  const error = plugins.snapshot().error;
  expect(await plugins.retryCredentialCleanup()).toBe(false);
  expect(plugins.snapshot().cleanupError).toContain("already running");
  expect(plugins.snapshot().error).toBe(error);
  edit.resolve(ready(false));
  await vi.advanceTimersByTimeAsync(0);
});

it("reads authoritative catalog immediately after accepted retry, never its returned summary", async () => {
  let release!: (value: { pending: number; running: number }) => void;
  const pending = new Promise<{ pending: number; running: number }>(
    (resolve) => {
      release = resolve;
    },
  );
  const retryCredentialCleanup = vi.fn(() => pending);
  const { plugins, installation } = harness({
    getCatalog: vi.fn(async () => cleanupCatalog(0, 0, true)),
    retryCredentialCleanup,
  });
  await vi.advanceTimersByTimeAsync(0);
  const retry = plugins.retryCredentialCleanup();
  vi.mocked(installation.getCatalog).mockResolvedValue(cleanupCatalog(1, 1));
  release({ pending: 0, running: 0 });
  expect(await retry).toBe(true);
  expect(installation.getCatalog).toHaveBeenCalledTimes(2);
  expect(plugins.snapshot().configuration).toEqual(cleanupCatalog(1, 1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(installation.getCatalog).toHaveBeenCalledTimes(3);
});

it.each(["resolve", "reject"] as const)(
  "does not publish an edit's %s after disposal before its watchdog",
  async (settlement) => {
    const pending = deferred();
    const { plugins, installation } = harness({
      changePlugin: () => pending.promise,
    });
    await vi.advanceTimersByTimeAsync(0);
    const change = plugins.change("remove", "example");
    const listener = vi.fn();
    plugins.subscribe(listener);
    await plugins.dispose();
    if (settlement === "resolve") pending.resolve(cleanupCatalog());
    else pending.reject(new Error("late edit error"));
    expect(await change).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listener).not.toHaveBeenCalled();
    expect(installation.getCatalog).toHaveBeenCalledTimes(1);
  },
);
