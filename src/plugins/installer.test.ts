import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  createPluginInstallCore,
  createPluginInstallLinkHandler,
  createPluginInstallRequests,
  parsePluginInstallSource,
  PluginInstallerService,
  type PluginInstaller,
  type PluginInstallOrigin,
} from "./installer";
import type { ConfigurationState, PluginInfo } from "./types";

const commit = "0123456789abcdef0123456789abcdef01234567";
const base = {
  repository: "https://example.com/team/plugins.git",
  reference: "main",
};

it("accepts HTTPS, SSH and scp-style repositories and normalizes the commit", () => {
  for (const repository of [
    "https://example.com/team/plugins.git",
    "ssh://git@example.com/team/plugins.git",
    "git@example.com:team/plugins.git",
    "https://github.com/owner/repository",
    "git@github.com:owner/repository.git",
  ])
    expect(parsePluginInstallSource({ ...base, repository })).toEqual({
      ...base,
      repository,
    });
  expect(
    parsePluginInstallSource({
      ...base,
      path: "dist/plugin",
      commit: commit.toUpperCase(),
    }),
  ).toEqual({ ...base, path: "dist/plugin", commit });
  expect(
    parsePluginInstallSource({ ...base, commit: "a".repeat(64) }),
  ).toMatchObject({ commit: "a".repeat(64) });
  expect(parsePluginInstallSource({ ...base, path: "." })).toMatchObject({
    path: ".",
  });
});

it.each([
  ["http transport", { repository: "http://example.com/team/plugins.git" }],
  ["file transport", { repository: "file:///tmp/plugins" }],
  ["bare GitHub shorthand", { repository: "owner/repository" }],
  ["a local path", { repository: "/tmp/plugins" }],
  ["a password", { repository: "https://user:secret@example.com/a.git" }],
  ["HTTPS credentials", { repository: "https://user@example.com/a.git" }],
  ["a query", { repository: "https://example.com/a.git?x=1" }],
  ["a fragment", { repository: "https://example.com/a.git#x" }],
  ["no repository path", { repository: "https://example.com/" }],
  ["whitespace", { repository: "https://example.com/a b.git" }],
  ["a non-string repository", { repository: 4 }],
  ["an empty reference", { reference: "" }],
  ["an option-like reference", { reference: "--upload-pack=x" }],
  ["a reference with spaces", { reference: "my branch" }],
  ["a reference with a parent segment", { reference: "a..b" }],
  ["a reference ending in a slash", { reference: "a/" }],
  ["an overlong reference", { reference: "a".repeat(201) }],
  ["an absolute path", { path: "/etc" }],
  ["a parent path", { path: "../x" }],
  ["an embedded parent path", { path: "a/../x" }],
  ["a backslash path", { path: "a\\b" }],
  ["a drive path", { path: "C:/x" }],
  ["an empty path segment", { path: "a//b" }],
  ["a trailing slash path", { path: "a/" }],
  ["an empty path", { path: "" }],
  [
    "ssh credentials other than git",
    { repository: "ssh://deploy@example.com/a.git" },
  ],
  [
    "a scp user other than git",
    { repository: "deploy@example.com:team/a.git" },
  ],
  [
    "an option-like https host",
    { repository: "https://-oProxy.example/a.git" },
  ],
  ["an option-like scp host", { repository: "git@-oProxy:team/a.git" }],
  ["a non-ASCII host", { repository: "https://exаmple.com/a.git" }],
  ["a format character", { repository: "https://example.com/a\u202e.git" }],
  [
    "a GitHub tree URL",
    { repository: "https://github.com/owner/repo/tree/main" },
  ],
  ["a GitHub owner only", { repository: "https://github.com/owner" }],
  ["a short commit", { commit: "abc1234" }],
  ["a non-hex commit", { commit: "g".repeat(40) }],
  ["a 41-character commit", { commit: "a".repeat(41) }],
  ["a non-string commit", { commit: 1 }],
])("rejects %s", (_name, change) => {
  expect(parsePluginInstallSource({ ...base, ...change })).toBeNull();
});

it("rejects a missing or non-object request", () => {
  expect(parsePluginInstallSource(undefined)).toBeNull();
  expect(parsePluginInstallSource("https://example.com/a.git")).toBeNull();
  expect(parsePluginInstallSource({ repository: base.repository })).toBeNull();
});

const origin: PluginInstallOrigin = { kind: "link" };

it("holds one request at a time and resolves it with the user's outcome", async () => {
  const requests = createPluginInstallRequests();
  const listener = vi.fn();
  requests.subscribe(listener);
  const first = requests.request(base, origin);
  const pending = requests.snapshot();
  expect(pending).toMatchObject({ source: base, origin });
  await expect(
    requests.request({ ...base, reference: "other" }, origin),
  ).resolves.toBe("unavailable");
  expect(requests.snapshot()).toBe(pending);
  requests.settle((pending?.id ?? 0) + 1, "installed");
  expect(requests.snapshot()).toBe(pending);
  requests.settle(pending?.id ?? 0, "updated");
  await expect(first).resolves.toBe("updated");
  expect(requests.snapshot()).toBeUndefined();
  requests.settle(pending?.id ?? 0, "installed");
  expect(listener).toHaveBeenCalledTimes(2);
  const next = requests.request(base, origin);
  expect(requests.snapshot()?.id).not.toBe(pending?.id);
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await expect(next).resolves.toBe("cancelled");
});

it("cancels an unclaimed request after its time to live and keeps a claimed one", async () => {
  vi.useFakeTimers();
  try {
    const requests = createPluginInstallRequests({ ttlMs: 1000 });
    const unclaimed = requests.request(base, origin);
    vi.advanceTimersByTime(999);
    expect(requests.snapshot()).toBeDefined();
    vi.advanceTimersByTime(1);
    await expect(unclaimed).resolves.toBe("cancelled");
    expect(requests.snapshot()).toBeUndefined();

    const claimed = requests.request(base, origin);
    requests.claim(requests.snapshot()?.id ?? 0);
    vi.advanceTimersByTime(60_000);
    expect(requests.snapshot()).toBeDefined();
    requests.settle(requests.snapshot()?.id ?? 0, "installed");
    await expect(claimed).resolves.toBe("installed");
  } finally {
    vi.useRealTimers();
  }
});

it("refuses a request while any review dialog is open", async () => {
  const requests = createPluginInstallRequests();
  const release = requests.holdReview();
  const second = requests.holdReview();
  await expect(requests.request(base, origin)).resolves.toBe("unavailable");
  release();
  release();
  await expect(requests.request(base, origin)).resolves.toBe("unavailable");
  second();
  const allowed = requests.request(base, origin);
  expect(requests.snapshot()).toBeDefined();
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await expect(allowed).resolves.toBe("cancelled");
});

const info = (
  id: string,
  revision: string,
  enabled = true,
  name = id,
): PluginInfo => ({
  manifest: { id, name, apiVersion: 1 },
  source: "external",
  enabled,
  revision,
  previous: null,
  reloadable: true,
  error: null,
});
const ready = (plugins: PluginInfo[], externalPluginsPaused = false) =>
  ({
    status: "ready",
    externalPluginsPaused,
    catalog: { profile: "test", location: "test", plugins },
  }) as ConfigurationState;

function setup({
  imports = {} as object | null,
  open = vi.fn(async () => ({ status: "opened" })),
  plugins = [info("example.one", "r1")],
  activation = () => true,
}: {
  imports?: object | null;
  open?: () => Promise<{ status: string }>;
  plugins?: PluginInfo[];
  activation?: () => boolean;
} = {}) {
  let configuration: ConfigurationState = ready(plugins);
  let clock = 1_000_000;
  const listeners = new Set<() => void>();
  const manager = {
    imports: imports ?? undefined,
    snapshot: () => ({ configuration }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const requests = createPluginInstallRequests();
  const core = createPluginInstallCore({
    plugins: manager as never,
    requests,
    openPlugins: open as never,
    activation,
    now: () => clock,
  });
  const root = new Context();
  const service = new PluginInstallerService(root, {
    plugins: manager as never,
    core,
  });
  const fibers: { dispose(): Promise<void> }[] = [];
  return {
    root,
    service,
    requests,
    core,
    manager,
    open,
    listeners,
    as(id: string) {
      let installer: PluginInstaller | undefined;
      const fiber = root
        .extend({ pluginOwner: { id, revision: "one" } })
        .plugin((ctx) => {
          installer = ctx.reflect.get("pluginInstaller");
        });
      fibers.push(fiber);
      return fiber.await().then(() => installer as PluginInstaller);
    },
    fibers,
    advance(ms: number) {
      clock += ms;
    },
    set(next: ConfigurationState) {
      configuration = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const settleRequest = (
  requests: ReturnType<typeof createPluginInstallRequests>,
  outcome: "installed" | "updated" | "cancelled",
) => requests.settle(requests.snapshot()?.id ?? 0, outcome);

it("is read by plugins through reflect and lists only id and enabled, frozen and stable", async () => {
  const { root, service, as } = setup({
    plugins: [info("example.one", "r1"), info("example.two", "r2", false)],
  });
  const installer = await as("example.market");
  const list = installer.installed();
  expect(list).toEqual([
    { id: "example.one", enabled: true },
    { id: "example.two", enabled: false },
  ]);
  expect(Object.keys(list[0] ?? {})).toEqual(["id", "enabled"]);
  expect(Object.isFrozen(list)).toBe(true);
  expect(Object.isFrozen(list[0])).toBe(true);
  expect(installer.installed()).toBe(list);
  expect(service.installed()).toBe(list);
  await root.fiber.dispose();
});

it("reports external plugins as disabled while they are paused", () => {
  const { service, set } = setup();
  set(ready([info("example.one", "r1")], true));
  expect(service.installed()).toEqual([{ id: "example.one", enabled: false }]);
  set({ status: "loading" });
  expect(service.installed()).toEqual([]);
  expect(Object.isFrozen(service.installed())).toBe(true);
});

it("notifies only when the installed list changes and stops after unsubscribe", async () => {
  const { set, as } = setup();
  const installer = await as("example.market");
  const listener = vi.fn();
  const stop = installer.subscribe(listener);
  set(ready([info("example.one", "r2")]));
  expect(listener).not.toHaveBeenCalled();
  set(ready([info("example.one", "r2", false)]));
  expect(listener).toHaveBeenCalledTimes(1);
  set({ status: "loading" });
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  set(ready([]));
  expect(listener).toHaveBeenCalledTimes(2);
});

it("ends a plugin's subscription with the plugin and survives a failing listener", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { set, listeners, as, fibers } = setup();
  const installer = await as("example.market");
  const failing = vi.fn(() => {
    throw new Error("listener failed");
  });
  installer.subscribe(failing);
  const other = vi.fn();
  installer.subscribe(other);
  set(ready([]));
  expect(failing).toHaveBeenCalledTimes(1);
  expect(other).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(2);
  await fibers[0]?.dispose();
  expect(listeners.size).toBe(0);
  set(ready([info("example.one", "r1")]));
  expect(failing).toHaveBeenCalledTimes(1);
  expect(other).toHaveBeenCalledTimes(1);
  error.mockRestore();
});

it("attributes a request to the calling plugin and resolves with the user's outcome", async () => {
  const { requests, open, as } = setup({
    plugins: [info("example.market", "r1", true, "Plugin\u202e Market")],
  });
  const installer = await as("example.market");
  const outcome = installer.requestInstall({ ...base, commit });
  expect(open).toHaveBeenCalledOnce();
  expect(requests.snapshot()).toMatchObject({
    source: { ...base, commit },
    origin: { kind: "plugin", id: "example.market", name: "Plugin Market" },
  });
  settleRequest(requests, "installed");
  await expect(outcome).resolves.toBe("installed");
});

it("labels an OS link request as a link and rejects an unattributed plugin call", async () => {
  const { requests, core, service } = setup();
  const outcome = core.submit(base);
  expect(requests.snapshot()?.origin).toEqual({ kind: "link" });
  settleRequest(requests, "cancelled");
  await expect(outcome).resolves.toBe("cancelled");
  await expect(service.requestInstall(base)).rejects.toThrow(
    /installed plugin/,
  );
});

it("is unavailable without native imports, before the catalog is ready, or while another request waits", async () => {
  const none = setup({ imports: null });
  await expect(
    (await none.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
  expect(none.open).not.toHaveBeenCalled();
  expect(none.requests.snapshot()).toBeUndefined();

  const loading = setup();
  loading.set({ status: "loading" });
  await expect(
    (await loading.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");

  const busy = setup();
  const installer = await busy.as("example.market");
  const first = installer.requestInstall(base);
  await expect(
    installer.requestInstall({ ...base, reference: "other" }),
  ).resolves.toBe("unavailable");
  expect(busy.open).toHaveBeenCalledOnce();
  expect(busy.requests.snapshot()?.source.reference).toBe("main");
  settleRequest(busy.requests, "cancelled");
  await expect(first).resolves.toBe("cancelled");
});

it("rejects an invalid request without opening Settings", async () => {
  const { open, requests, as } = setup();
  const installer = await as("example.market");
  await expect(
    installer.requestInstall({
      ...base,
      repository: "http://example.com/a.git",
    }),
  ).rejects.toThrow(/HTTPS, SSH or scp-style/);
  await expect(
    installer.requestInstall({ ...base, path: "../x" }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(requests.snapshot()).toBeUndefined();
});

it("does not leave a request waiting when Settings cannot open", async () => {
  const failed = setup({ open: vi.fn(async () => ({ status: "failed" })) });
  await expect(
    (await failed.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
  expect(failed.requests.snapshot()).toBeUndefined();

  const superseded = setup({
    open: vi.fn(async () => ({ status: "superseded" })),
  });
  await expect(
    (await superseded.as("example.market")).requestInstall(base),
  ).resolves.toBe("cancelled");

  const rejected = setup({
    open: vi.fn(async () => {
      throw new Error("no");
    }),
  });
  await expect(
    (await rejected.as("example.market")).requestInstall(base),
  ).resolves.toBe("unavailable");
});

it("cools a plugin down after each cancel with backoff, and forgives an install", async () => {
  const { requests, open, as, advance } = setup();
  const installer = await as("example.market");
  const other = await as("example.other");

  const first = installer.requestInstall(base);
  settleRequest(requests, "cancelled");
  await expect(first).resolves.toBe("cancelled");

  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");
  expect(open).toHaveBeenCalledOnce();
  advance(4_999);
  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");

  const unrelated = other.requestInstall(base);
  expect(open).toHaveBeenCalledTimes(2);
  settleRequest(requests, "installed");
  await expect(unrelated).resolves.toBe("installed");

  advance(1);
  const second = installer.requestInstall(base);
  settleRequest(requests, "cancelled");
  await expect(second).resolves.toBe("cancelled");
  advance(9_999);
  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");
  advance(1);
  const third = installer.requestInstall(base);
  settleRequest(requests, "installed");
  await expect(third).resolves.toBe("installed");

  const after = installer.requestInstall(base);
  expect(requests.snapshot()).toBeDefined();
  settleRequest(requests, "cancelled");
  await after;
  advance(5_000);
  const again = installer.requestInstall(base);
  expect(requests.snapshot()).toBeDefined();
  settleRequest(requests, "cancelled");
  await again;
});

it("caps accepted requests per plugin for the session without counting refusals", async () => {
  const { requests, open, as } = setup();
  const installer = await as("example.market");
  for (let index = 0; index < 20; index++) {
    const outcome = installer.requestInstall(base);
    settleRequest(requests, "installed");
    await outcome;
  }
  expect(open).toHaveBeenCalledTimes(20);
  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");
  expect(open).toHaveBeenCalledTimes(20);
  const other = await as("example.other");
  const outcome = other.requestInstall(base);
  expect(open).toHaveBeenCalledTimes(21);
  settleRequest(requests, "installed");
  await outcome;
});

it("requires transient user activation for plugin calls only, without spending the cap", async () => {
  let active = false;
  const { requests, open, core, as } = setup({ activation: () => active });
  const installer = await as("example.market");
  await expect(installer.requestInstall(base)).resolves.toBe("unavailable");
  expect(open).not.toHaveBeenCalled();
  active = true;
  const outcome = installer.requestInstall(base);
  expect(open).toHaveBeenCalledOnce();
  settleRequest(requests, "installed");
  await outcome;
  active = false;
  const link = core.submit(base);
  expect(open).toHaveBeenCalledTimes(2);
  settleRequest(requests, "installed");
  await link;
});

it("reads the browser's activation state when it reports one", async () => {
  const requests = createPluginInstallRequests();
  const open = vi.fn(async () => ({ status: "opened" }));
  const manager = {
    imports: {},
    snapshot: () => ({ configuration: ready([]) }),
    subscribe: () => () => {},
  };
  const core = createPluginInstallCore({
    plugins: manager as never,
    requests,
    openPlugins: open,
  });
  vi.stubGlobal("navigator", { userActivation: { isActive: false } });
  try {
    await expect(core.submit(base, { id: "example.market" })).resolves.toBe(
      "unavailable",
    );
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const outcome = core.submit(base, { id: "example.market" });
    expect(open).toHaveBeenCalledOnce();
    settleRequest(requests, "cancelled");
    await outcome;
    vi.stubGlobal("navigator", {});
    const unreported = core.submit(base, { id: "example.other" });
    expect(open).toHaveBeenCalledTimes(2);
    settleRequest(requests, "cancelled");
    await unreported;
  } finally {
    vi.unstubAllGlobals();
  }
});

function linkHandler(initial: ConfigurationState) {
  let configuration = initial;
  const listeners = new Set<() => void>();
  const submit = vi.fn(async (_source: unknown) => "unavailable" as string);
  const fail = vi.fn();
  const handler = createPluginInstallLinkHandler({
    plugins: {
      snapshot: () => ({ configuration }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    core: { submit } as never,
    fail,
  });
  return {
    handler,
    submit,
    fail,
    listeners,
    become(next: ConfigurationState) {
      configuration = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

it("holds an OS link until plugin settings settle, then submits the newest one", async () => {
  const t = linkHandler({ status: "loading" });
  t.submit.mockResolvedValue("installed");
  t.handler.handle({ source: base });
  t.handler.handle({ source: { ...base, reference: "newer" } });
  expect(t.listeners.size).toBe(1);
  expect(t.submit).not.toHaveBeenCalled();
  t.become({ status: "loading" });
  expect(t.submit).not.toHaveBeenCalled();
  t.become(ready([]));
  expect(t.submit).toHaveBeenCalledOnce();
  expect(t.submit).toHaveBeenCalledWith({ ...base, reference: "newer" });
  expect(t.listeners.size).toBe(0);
  await Promise.resolve();
  expect(t.fail).not.toHaveBeenCalled();
});

it("submits at once when settings are loaded, and reports a refusal with a retry", async () => {
  const t = linkHandler(ready([]));
  t.handler.handle({ source: base });
  expect(t.submit).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(t.fail).toHaveBeenCalledOnce());
  expect(t.fail).toHaveBeenCalledWith("unavailable", expect.any(Function));
  t.submit.mockResolvedValue("installed");
  await t.fail.mock.calls[0]?.[1]();
  expect(t.submit).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(t.fail).toHaveBeenCalledOnce();
});

it("stops waiting for settings when disposed", () => {
  const t = linkHandler({ status: "loading" });
  t.handler.handle({ source: base });
  t.handler.dispose();
  t.become(ready([]));
  expect(t.submit).not.toHaveBeenCalled();
  expect(t.listeners.size).toBe(0);
});
