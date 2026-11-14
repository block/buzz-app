import { expect, it, vi } from "vitest";
import {
  createPluginUpdateChecks,
  pluginUpdateCheck,
  pluginUpdateAvailable,
} from "./update-checks";
import type { PluginImports, PluginInfo } from "./types";
const plugin = (id = "example.one", path = "one") =>
  ({
    manifest: { id, name: id, apiVersion: 1 },
    source: "external",
    enabled: true,
    revision: "installed",
    previous: null,
    reloadable: true,
    error: null,
    updateSource: {
      repository: "https://example.com/plugins",
      reference: "main",
      path,
    },
  }) satisfies PluginInfo;
const preview = (revision: string) => ({
  token: "",
  source: "https://example.com/plugins",
  commit: null,
  warnings: [],
  candidates: [plugin(), plugin("example.two", "two")].map((item) => ({
    path: item.updateSource.path,
    manifest: item.manifest,
    revision,
  })),
});

it.each([false, true])(
  "bounds distinct Git reads and drains after failure=%s",
  async (fail) => {
    const finishes: Array<(failed?: boolean) => void> = [];
    const checkGit = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          finishes.push((failed) =>
            failed
              ? reject(new Error("offline"))
              : resolve({
                  ...preview("new"),
                  candidates: plugins.map((item) => ({
                    path: item.updateSource.path,
                    manifest: item.manifest,
                    revision: "new",
                  })),
                }),
          );
        }),
    );
    const checkFolder = vi.fn(async () => ({ revision: "folder-new" }));
    const checks = createPluginUpdateChecks({
      checkGit,
      checkFolder,
    } as unknown as PluginImports);
    const plugins = [0, 1, 2, 3].map((index) => ({
      ...plugin(`example.${index}`),
      updateSource: {
        ...plugin().updateSource,
        repository: `https://example.com/${index}`,
      },
    }));
    const reads = plugins.map((item) => checks.check(item));
    const duplicates = plugins.map((item) => checks.check(item));
    const folder = {
      ...plugin("example.folder"),
      updateSource: { root: "/plugins", path: "." },
    };
    await checks.check(folder);
    expect(
      pluginUpdateCheck(checks.snapshot(), folder)?.release?.revision,
    ).toBe("folder-new");
    expect(checkGit).toHaveBeenCalledTimes(2);
    finishes[0]?.(fail);
    await vi.waitFor(() => expect(checkGit).toHaveBeenCalledTimes(3));
    finishes[1]?.();
    await vi.waitFor(() => expect(checkGit).toHaveBeenCalledTimes(4));
    finishes[2]?.();
    finishes[3]?.();
    await Promise.all([...reads, ...duplicates]);
    expect(pluginUpdateCheck(checks.snapshot(), plugins[0])?.error).toBe(
      fail ? "Error: offline" : null,
    );
    expect(
      plugins.every(
        (item) => !pluginUpdateCheck(checks.snapshot(), item)?.checking,
      ),
    ).toBe(true);
  },
);

it("shares repeated checks while keeping sibling Git paths scoped", async () => {
  const finishes: Array<(value: ReturnType<typeof preview>) => void> = [];
  const checkGit = vi.fn(
    () =>
      new Promise<ReturnType<typeof preview>>((resolve) =>
        finishes.push(resolve),
      ),
  );
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin());
  const sequence = pluginUpdateCheck(checks.snapshot(), plugin())?.sequence;
  const again = checks.check(plugin());
  const sibling = checks.check(plugin("example.two", "two"));
  await Promise.resolve();
  expect(checkGit).toHaveBeenCalledTimes(2);
  expect(checkGit).toHaveBeenNthCalledWith(
    1,
    "https://example.com/plugins",
    "main",
    undefined,
    { commit: undefined, path: "one" },
  );
  expect(checkGit).toHaveBeenNthCalledWith(
    2,
    "https://example.com/plugins",
    "main",
    undefined,
    { commit: undefined, path: "two" },
  );
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.sequence).toBe(
    sequence,
  );
  for (const finish of finishes) finish(preview("new"));
  await Promise.all([first, again, sibling]);
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(true);
  expect(
    pluginUpdateAvailable(checks.snapshot(), plugin("example.two", "two")),
  ).toBe(true);
});

it("does not promote an old pending acquisition over a newer observed read", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("newest"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin());
  checks.observe(plugin())({ revision: "newer" });
  const joined = checks.check(plugin());
  expect(
    pluginUpdateCheck(checks.snapshot(), plugin())?.release?.revision,
  ).toBe("newer");
  await Promise.resolve();
  finish(preview("installed"));
  await first;
  expect(
    pluginUpdateCheck(checks.snapshot(), plugin())?.release?.revision,
  ).not.toBe("installed");
  await joined;
  expect(checkGit).toHaveBeenCalledTimes(2);
  expect(
    pluginUpdateCheck(checks.snapshot(), plugin())?.release?.revision,
  ).toBe("newest");
});

it("rejects an older observed read after a newer source acquisition completes", async () => {
  const checkGit = vi.fn(async () => preview("installed"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const older = checks.observe(plugin());
  await checks.check(plugin());
  older({ revision: "stale" });
  expect(
    pluginUpdateCheck(checks.snapshot(), plugin())?.release?.revision,
  ).toBe("installed");
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
});

it.each([false, true])(
  "clears availability after an unavailable source (missing=%s)",
  async (missing) => {
    const checkGit = vi.fn().mockResolvedValueOnce(preview("new"));
    if (missing)
      checkGit.mockResolvedValue({
        ...preview("new"),
        candidates: [],
        warnings: ["one: Missing plugin"],
      });
    else checkGit.mockRejectedValue(new Error("offline"));
    const checks = createPluginUpdateChecks({
      checkGit,
    } as unknown as PluginImports);
    await checks.check(plugin());
    expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(true);
    await checks.check(plugin());
    const result = pluginUpdateCheck(checks.snapshot(), plugin());
    expect(result?.checking).toBe(false);
    expect(result?.release?.revision).toBeUndefined();
    expect(result?.error).toContain(
      missing ? "one: Missing plugin" : "offline",
    );
    expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
  },
);

it("records a failed preview read without keeping a stale revision", () => {
  const checks = createPluginUpdateChecks(undefined);
  checks.observe(plugin())({ revision: "new" });
  checks.observe(plugin())(undefined, "Source unavailable");
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.error).toBe(
    "Source unavailable",
  );
});

it("drops an obsolete installation retry after rollback rejoins the original read", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("obsolete"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const original = plugin();
  const first = checks.check(original);
  await Promise.resolve();
  const obsolete = checks.check({ ...original, revision: "temporary" });
  const latest = checks.check(original);
  await Promise.resolve();
  finish(preview("new"));
  await Promise.all([first, obsolete, latest]);
  expect(checkGit).toHaveBeenCalledOnce();
  expect(
    pluginUpdateCheck(checks.snapshot(), original)?.release?.revision,
  ).toBe("new");
});

it("does not retry a replaced source after its old read settles", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("new"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const original = plugin();
  const first = checks.check(original);
  await Promise.resolve();
  const obsolete = checks.check({ ...original, revision: "temporary" });
  const replacement = {
    ...original,
    updateSource: {
      ...original.updateSource,
      repository: "https://example.com/replacement",
    },
  };
  await checks.check(replacement);
  finish(preview("old"));
  await Promise.all([first, obsolete]);
  expect(checkGit).toHaveBeenCalledTimes(2);
  expect(
    pluginUpdateCheck(checks.snapshot(), replacement)?.release?.revision,
  ).toBe("new");
});

it("retires queued folder reads when eligibility is revoked", async () => {
  let finish!: (value: { revision: string }) => void;
  let eligible = true;
  const folder = {
    ...plugin(),
    updateSource: { root: "/plugins", path: "." },
  };
  const checkFolder = vi.fn(
    () =>
      new Promise<{ revision: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const checks = createPluginUpdateChecks({
    checkFolder,
  } as unknown as PluginImports);
  const first = checks.check(folder, undefined, () => eligible);
  checks.observe(folder)({ revision: "newer" });
  const queued = checks.check(folder, undefined, () => eligible);
  eligible = false;
  finish({ revision: "old" });
  await Promise.all([first, queued]);
  expect(checkFolder).toHaveBeenCalledOnce();
  expect(pluginUpdateCheck(checks.snapshot(), folder)?.release?.revision).toBe(
    "newer",
  );
});

it("settles the pending indicator without publishing an ineligible folder result", async () => {
  let finish!: (value: { revision: string }) => void;
  let eligible = true;
  const folder = {
    ...plugin(),
    updateSource: { root: "/plugins", path: "." },
  };
  const checkFolder = vi.fn(
    () =>
      new Promise<{ revision: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const checks = createPluginUpdateChecks({
    checkFolder,
  } as unknown as PluginImports);
  const checking = checks.check(folder, undefined, () => eligible);
  eligible = false;
  finish({ revision: "new" });
  await checking;
  expect(pluginUpdateCheck(checks.snapshot(), folder)?.checking).toBe(false);
  expect(
    pluginUpdateCheck(checks.snapshot(), folder)?.release?.revision,
  ).toBeUndefined();
  expect(pluginUpdateCheck(checks.snapshot(), folder)?.error).toBeNull();
});

it("ignores pinned URL sources without authorizing or acquiring a repository", async () => {
  const checkGit = vi.fn(async () => preview("new"));
  const checkFolder = vi.fn();
  const authorize = vi.fn(async () => null);
  const checks = createPluginUpdateChecks({
    checkGit,
    checkFolder,
  } as unknown as PluginImports);
  const pinned: PluginInfo = {
    ...plugin(),
    updateSource: {
      url: "https://plugins.example.org/plugin.json",
      sha256: "a".repeat(64),
    },
  };
  await checks.check(pinned, authorize);
  expect(authorize).not.toHaveBeenCalled();
  expect(checkGit).not.toHaveBeenCalled();
  expect(checkFolder).not.toHaveBeenCalled();
  expect(checks.snapshot()).toEqual({});
});

it.each(["folder", "git"])(
  "retains publisher-only repairs in shared %s results",
  async (source) => {
    const installed: PluginInfo = {
      ...plugin(),
      publisher: null,
      ...(source === "folder" && {
        updateSource: { root: "/plugins", path: "one" },
      }),
    };
    const signed = { revision: installed.revision, publisher: "a".repeat(64) };
    const candidate = {
      path: "one",
      manifest: installed.manifest,
      ...signed,
    };
    const checks = createPluginUpdateChecks({
      checkFolder: vi.fn(async () => signed),
      checkGit: vi.fn(async () => ({
        ...preview(installed.revision),
        candidates: [candidate],
      })),
    } as unknown as PluginImports);
    await checks.check(installed);
    expect(
      pluginUpdateCheck(checks.snapshot(), installed)?.release,
    ).toMatchObject(signed);
    expect(pluginUpdateAvailable(checks.snapshot(), installed)).toBe(true);
    const repaired = { ...installed, ...signed };
    expect(pluginUpdateCheck(checks.snapshot(), repaired)).toBeUndefined();
    await checks.check(repaired);
    expect(pluginUpdateAvailable(checks.snapshot(), repaired)).toBe(false);
  },
);

it("rejects a late observed result when only the installed publisher changes", () => {
  const checks = createPluginUpdateChecks(undefined);
  const unsigned = { ...plugin(), publisher: null };
  const oldRead = checks.observe(unsigned);
  const repaired = { ...unsigned, publisher: "a".repeat(64) };
  checks.observe(repaired)(repaired);
  expect(oldRead({ revision: "obsolete" })).toBe(false);
  expect(pluginUpdateCheck(checks.snapshot(), repaired)?.release).toEqual(
    repaired,
  );
});
