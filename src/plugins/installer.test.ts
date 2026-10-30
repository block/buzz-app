import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  createPluginInstallRequests,
  parsePluginInstallSource,
  PluginInstallerService,
  type PluginInstaller,
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

it("holds one request at a time and resolves it with the user's outcome", async () => {
  const requests = createPluginInstallRequests();
  const listener = vi.fn();
  requests.subscribe(listener);
  const first = requests.request(base);
  const pending = requests.snapshot();
  expect(pending?.source).toEqual(base);
  await expect(requests.request({ ...base, reference: "other" })).resolves.toBe(
    "unavailable",
  );
  expect(requests.snapshot()).toBe(pending);
  requests.settle((pending?.id ?? 0) + 1, "installed");
  expect(requests.snapshot()).toBe(pending);
  requests.settle(pending?.id ?? 0, "updated");
  await expect(first).resolves.toBe("updated");
  expect(requests.snapshot()).toBeUndefined();
  requests.settle(pending?.id ?? 0, "installed");
  expect(listener).toHaveBeenCalledTimes(2);
  const next = requests.request(base);
  expect(requests.snapshot()?.id).not.toBe(pending?.id);
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await expect(next).resolves.toBe("cancelled");
});

const info = (id: string, revision: string, enabled = true): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 },
  source: "external",
  enabled,
  revision,
  previous: null,
  reloadable: true,
  error: null,
});

function setup({
  imports = {} as object | null,
  open = vi.fn(async () => ({ status: "opened" })),
  plugins = [info("example.one", "r1")],
}: {
  imports?: object | null;
  open?: () => Promise<{ status: string }>;
  plugins?: PluginInfo[];
} = {}) {
  let configuration: ConfigurationState = {
    status: "ready",
    catalog: { profile: "test", location: "test", plugins },
  } as ConfigurationState;
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
  const root = new Context();
  const service = new PluginInstallerService(root, {
    plugins: manager as never,
    requests,
    openPlugins: open as never,
  });
  return {
    root,
    service,
    requests,
    open,
    set(next: ConfigurationState) {
      configuration = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

it("is read by plugins through reflect and lists installed plugins", async () => {
  const { root, service } = setup();
  let seen: unknown;
  const fiber = root
    .extend({ pluginOwner: { id: "example.market", revision: "one" } })
    .plugin((ctx) => {
      seen = ctx.reflect.get("pluginInstaller");
    });
  await fiber.await();
  const installer = seen as PluginInstaller;
  expect(installer.installed()).toBe(service.installed());
  expect(installer.installed()).toEqual([
    { id: "example.one", revision: "r1", enabled: true },
  ]);
  expect(service.installed()).toBe(service.installed());
  await root.fiber.dispose();
});

it("notifies only when the installed list changes and stops after unsubscribe", () => {
  const { service, set } = setup();
  const listener = vi.fn();
  const stop = service.subscribe(listener);
  const ready = (plugins: PluginInfo[]) =>
    ({
      status: "ready",
      catalog: { profile: "test", location: "test", plugins },
    }) as ConfigurationState;
  set(ready([info("example.one", "r1")]));
  expect(listener).not.toHaveBeenCalled();
  set(ready([info("example.one", "r2")]));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(service.installed()).toEqual([
    { id: "example.one", revision: "r2", enabled: true },
  ]);
  set(ready([info("example.one", "r2", false)]));
  expect(listener).toHaveBeenCalledTimes(2);
  set({ status: "loading" });
  expect(service.installed()).toEqual([]);
  stop();
  set(ready([]));
  expect(listener).toHaveBeenCalledTimes(3);
});

it("opens Settings → Plugins for review and resolves with the user's outcome", async () => {
  const { service, requests, open } = setup();
  const outcome = service.requestInstall({ ...base, commit });
  expect(open).toHaveBeenCalledOnce();
  expect(requests.snapshot()?.source).toEqual({ ...base, commit });
  requests.settle(requests.snapshot()?.id ?? 0, "installed");
  await expect(outcome).resolves.toBe("installed");
});

it("is unavailable without native imports, before the catalog is ready, or while another request waits", async () => {
  const none = setup({ imports: null });
  await expect(none.service.requestInstall(base)).resolves.toBe("unavailable");
  expect(none.open).not.toHaveBeenCalled();
  expect(none.requests.snapshot()).toBeUndefined();

  const loading = setup();
  loading.set({ status: "loading" });
  await expect(loading.service.requestInstall(base)).resolves.toBe(
    "unavailable",
  );

  const busy = setup();
  const first = busy.service.requestInstall(base);
  await expect(
    busy.service.requestInstall({ ...base, reference: "other" }),
  ).resolves.toBe("unavailable");
  expect(busy.open).toHaveBeenCalledOnce();
  expect(busy.requests.snapshot()?.source.reference).toBe("main");
  busy.requests.settle(busy.requests.snapshot()?.id ?? 0, "cancelled");
  await expect(first).resolves.toBe("cancelled");
});

it("rejects an invalid request without opening Settings", async () => {
  const { service, open, requests } = setup();
  await expect(
    service.requestInstall({ ...base, repository: "http://example.com/a.git" }),
  ).rejects.toThrow(/HTTPS, SSH or scp-style/);
  await expect(
    service.requestInstall({ ...base, path: "../x" }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(requests.snapshot()).toBeUndefined();
});

it("does not leave a request waiting when Settings cannot open", async () => {
  const failed = setup({
    open: vi.fn(async () => ({ status: "failed" })),
  });
  await expect(failed.service.requestInstall(base)).resolves.toBe(
    "unavailable",
  );
  expect(failed.requests.snapshot()).toBeUndefined();

  const superseded = setup({
    open: vi.fn(async () => ({ status: "superseded" })),
  });
  await expect(superseded.service.requestInstall(base)).resolves.toBe(
    "cancelled",
  );

  const rejected = setup({
    open: vi.fn(async () => {
      throw new Error("no");
    }),
  });
  await expect(rejected.service.requestInstall(base)).resolves.toBe(
    "unavailable",
  );
});
