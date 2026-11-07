import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "./manager";
import type { ImportPreview, PluginInfo, StorageResult } from "./types";
import { createPluginUpdates } from "./updates";
import {
  sharedPluginUpdateChecks,
  pluginUpdateAvailable,
} from "./update-checks";

afterEach(() => vi.useRealTimers());

function fixture() {
  const source = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: ".",
  };
  const plugin: PluginInfo = {
    manifest: {
      id: "example.notes",
      name: "Notes",
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
    source: "external",
    enabled: true,
    revision: "old",
    previous: null,
    reloadable: true,
    error: null,
    updateSource: source,
  };
  let configuration: StorageResult = {
    status: "ready",
    externalPluginsPaused: false,
    catalog: { profile: "test", location: "test", plugins: [plugin] },
  };
  const listeners = new Set<() => void>();
  const candidate = { path: ".", manifest: plugin.manifest, revision: "new" };
  const preview: ImportPreview = {
    token: "",
    source: source.repository,
    commit: "a".repeat(40),
    candidates: [candidate],
    warnings: [],
  };
  const checkGit = vi.fn(async () => preview);
  const imports = {
    checkGit,
    git: vi.fn(),
    install: vi.fn(),
    discard: vi.fn(),
  };
  const manager = {
    imports,
    snapshot: () => ({ configuration }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginManager;
  const authorize = vi.fn(async () => null);
  return {
    plugin,
    candidate,
    preview,
    checkGit,
    imports,
    manager,
    authorize,
    set(next: StorageResult) {
      configuration = next;
      for (const listener of listeners) listener();
    },
    get: () => configuration,
  };
}

it.each([
  [undefined, undefined, false],
  [undefined, true, false],
  [{ defaultEnabled: false }, undefined, false],
  [{ defaultEnabled: false }, true, true],
  [{ defaultEnabled: true }, undefined, true],
  [{ defaultEnabled: true }, false, false],
] as const)(
  "checks only when the installed plugin and user policy allow it (%j, %j)",
  async (policy, choice, expected) => {
    const f = fixture();
    const manifest = { ...f.plugin.manifest };
    delete manifest.updates;
    f.plugin.manifest = policy ? { ...manifest, updates: policy } : manifest;
    f.plugin.updateChecks = choice ?? null;
    const updates = createPluginUpdates(f.manager, f.authorize);
    await updates.check();
    expect(f.checkGit).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(f.authorize).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(updates.snapshot()).toHaveLength(expected ? 1 : 0);
    updates.dispose();
  },
);

it("retires a notice on opt-out and checks immediately on opt-in", async () => {
  const f = fixture();
  f.plugin.updateChecks = false;
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  f.plugin.updateChecks = true;
  f.set(f.get());
  await updates.check();
  expect(updates.snapshot()).toHaveLength(1);
  f.plugin.updateChecks = false;
  f.set(f.get());
  expect(updates.snapshot()).toEqual([]);
  await updates.check(true);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  updates.dispose();
});

it.each([false, true])(
  "rechecks opt-out after Git authorization; shared request needed: %s",
  async (shared) => {
    const f = fixture();
    const configuration = f.get();
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    if (shared) {
      f.set({
        ...configuration,
        catalog: {
          ...configuration.catalog,
          plugins: [
            f.plugin,
            {
              ...f.plugin,
              manifest: { ...f.plugin.manifest, id: "example.other" },
            },
          ],
        },
      });
    }
    let finish!: (value: null) => void;
    f.authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const updates = createPluginUpdates(f.manager, f.authorize);
    const pending = updates.check();
    expect(f.authorize).toHaveBeenCalledTimes(1);
    f.plugin.updateChecks = false;
    f.set(f.get());
    finish(null);
    await pending;
    expect(f.checkGit).toHaveBeenCalledTimes(shared ? 1 : 0);
    expect(
      updates.snapshot().some((update) => update.id === f.plugin.manifest.id),
    ).toBe(false);
    updates.dispose();
  },
);

it("discovers without acquiring a preview or installing; Later lasts for the candidate and run", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  const first = updates.snapshot()[0];
  expect(first?.candidate?.revision).toBe("new");
  expect(f.imports.git).not.toHaveBeenCalled();
  expect(f.imports.install).not.toHaveBeenCalled();
  expect(f.imports.discard).not.toHaveBeenCalled();
  if (!first) throw new Error("Expected update");
  updates.later(first);
  expect(updates.hidden(first)).toBe(true);
  await updates.check();
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3_600_000);
  await updates.check();
  expect(updates.snapshot().map(updates.hidden)).toEqual([true]);
  f.candidate.revision = "newer";
  await updates.check(true);
  expect(updates.snapshot().map(updates.hidden)).toEqual([false]);
  updates.dispose();
  const nextRun = createPluginUpdates(f.manager, f.authorize);
  await nextRun.check();
  expect(nextRun.snapshot().map(nextRun.hidden)).toEqual([false]);
  nextRun.dispose();
});

it("keeps a useful authentication error and retries discovery without installation", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("SSH authentication failed"));
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.error).toBe("SSH authentication failed");
  await updates.check(true);
  expect(updates.snapshot()[0]?.candidate?.revision).toBe("new");
  expect(f.imports.install).not.toHaveBeenCalled();
  updates.dispose();
});

it("retains an explicit retry while another repository is pending", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const other = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other" },
    updateSource: {
      repository: "https://example.com/other.git",
      reference: "main",
      path: ".",
    },
  };
  f.preview.candidates.push({
    path: ".",
    manifest: other.manifest,
    revision: "new",
  });
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, other] },
  });
  f.authorize.mockRejectedValueOnce(new Error("SSH authentication failed"));
  let started!: () => void;
  const discovery = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const running = updates.check();
  await discovery;
  let retried: ReturnType<typeof updates.check> | undefined;
  try {
    expect(updates.snapshot()[0]?.error).toBe("SSH authentication failed");
    retried = updates.check(true);
    expect(f.checkGit).toHaveBeenCalledTimes(1);
  } finally {
    finish(f.preview);
    await running;
    await retried;
    updates.dispose();
  }
  expect(f.checkGit).toHaveBeenCalledTimes(3);
  const retriedUpdate = updates
    .snapshot()
    .find((update) => update.id === f.plugin.manifest.id);
  expect(retriedUpdate?.candidate?.revision).toBe("new");
  expect(retriedUpdate?.error).toBeUndefined();
  expect(f.imports.install).not.toHaveBeenCalled();
});

it("requires the managed commit and removes a candidate when its source changes", async () => {
  const f = fixture();
  const config = f.get();
  if (config.status !== "ready") throw new Error("Expected catalog");
  f.set({
    ...config,
    managed: {
      status: "ready",
      path: "policy",
      source: "Example",
      plugins: [
        {
          id: f.plugin.manifest.id,
          repository: "https://example.com/plugins.git",
          reference: "release",
          path: ".",
          commit: "b".repeat(40),
          state: "outdated",
        },
      ],
      problems: [],
    },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.error).toContain("managed commit");
  expect(f.imports.install).not.toHaveBeenCalled();
  f.preview.commit = "b".repeat(40);
  await updates.check(true);
  expect(updates.snapshot()[0]?.source.commit).toBe("b".repeat(40));
  f.set({
    ...config,
    catalog: {
      ...config.catalog,
      plugins: [
        {
          ...f.plugin,
          updateSource: {
            repository: "https://example.com/other.git",
            reference: "main",
            path: ".",
          },
        },
      ],
    },
  });
  expect(updates.snapshot()).toEqual([]);
  updates.dispose();
});

it("discards late discovery after disposal or removal and prevents overlapping checks", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  await Promise.resolve();
  const retried = updates.check(true);
  expect(f.checkGit).toHaveBeenCalledTimes(1);
  updates.dispose();
  resolve(f.preview);
  await pending;
  await retried;
  expect(updates.snapshot()).toEqual([]);
});

it("checks a saved Git source after its recommendation is removed", async () => {
  const f = fixture();
  const source = f.plugin.updateSource;
  if (!source || !("repository" in source))
    throw new Error("Expected Git source");
  f.plugin.updateSource = { ...source, commit: "b".repeat(40) };
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.candidate?.revision).toBe("new");
  expect(updates.snapshot()[0]?.source.commit).toBeUndefined();
  updates.dispose();
});

it("reuses discovery for plugins in the same repository and reference", async () => {
  const f = fixture();
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const source = f.plugin.updateSource;
  if (!source || !("repository" in source))
    throw new Error("Expected Git source");
  const other = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other" },
    updateSource: { ...source, path: "other" },
  };
  const stable = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.stable" },
    updateSource: { ...source, reference: "stable" },
  };
  f.preview.candidates.push(
    { path: "other", manifest: other.manifest, revision: "other-new" },
    { path: ".", manifest: stable.manifest, revision: "stable-new" },
  );
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [f.plugin, other, stable] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(
    updates.snapshot().map((update) => update.candidate?.revision),
  ).toEqual(["new", "other-new", "stable-new"]);
  expect(f.checkGit).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  updates.dispose();
});

it("publishes the same discovered Git update to background notices and the plugin list", async () => {
  const f = fixture();
  const updates = createPluginUpdates(f.manager, f.authorize);
  try {
    await updates.check();
    expect(updates.snapshot()[0]?.candidate?.revision).toBe("new");
    expect(
      pluginUpdateAvailable(
        sharedPluginUpdateChecks(f.manager.imports).snapshot(),
        f.plugin,
      ),
    ).toBe(true);
  } finally {
    updates.dispose();
  }
});

it("checks saved folders under the background owner and retains their list result", async () => {
  const f = fixture();
  f.plugin.updateSource = { root: "/plugins/notes", path: "." };
  const checkFolder = vi.fn(async () => "new");
  Object.assign(f.imports, { checkFolder });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const checks = sharedPluginUpdateChecks(f.manager.imports);
  await updates.check();
  expect(checkFolder).toHaveBeenCalledExactlyOnceWith(f.plugin.manifest.id);
  await vi.waitFor(() =>
    expect(pluginUpdateAvailable(checks.snapshot(), f.plugin)).toBe(true),
  );
  expect(f.checkGit).not.toHaveBeenCalled();
  expect(f.imports.git).not.toHaveBeenCalled();
  await updates.check();
  expect(checkFolder).toHaveBeenCalledOnce();
  updates.dispose();
});

it("keeps newer explicit results when a sibling consumes an older repository snapshot", async () => {
  const f = fixture();
  const state = f.get();
  if (state.status !== "ready") throw new Error("fixture catalog missing");
  const slow = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "slow" },
    updateSource: {
      repository: "https://example.com/slow",
      reference: "main",
      path: ".",
    },
  };
  const sibling = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "sibling" },
  };
  f.preview.candidates.push({ ...f.candidate, manifest: sibling.manifest });
  f.set({
    ...state,
    catalog: { ...state.catalog, plugins: [f.plugin, slow, sibling] },
  });
  let release!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementation(async (repository?: string) =>
    repository === "https://example.com/slow"
      ? new Promise<ImportPreview>((resolve) => {
          release = resolve;
        })
      : f.preview,
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const checks = sharedPluginUpdateChecks(f.manager.imports);
  checks.observe(sibling)("newer");
  release(f.preview);
  await pending;
  expect(checks.snapshot()[sibling.manifest.id]?.revision).toBe("newer");
  updates.dispose();
});

it("does not reacquire unrelated Git sources when a saved-folder revision changes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const f = fixture();
  const state = f.get();
  if (state.status !== "ready") throw new Error("fixture catalog missing");
  const folder = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "folder" },
    updateSource: { root: "/plugins", path: "." },
  };
  Object.assign(f.imports, { checkFolder: vi.fn(async () => "folder-new") });
  f.set({
    ...state,
    catalog: { ...state.catalog, plugins: [folder, f.plugin] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  vi.setSystemTime(1_000);
  folder.revision = "folder-new";
  f.set(f.get());
  expect(await updates.check()).toBe(3_599_000);
  expect(f.checkGit).toHaveBeenCalledOnce();
  updates.dispose();
});

it("retires an error notice when a successful explicit check supersedes background recovery", async () => {
  const f = fixture();
  f.checkGit.mockRejectedValueOnce(new Error("offline"));
  const updates = createPluginUpdates(f.manager, f.authorize);
  await updates.check();
  expect(updates.snapshot()[0]?.error).toContain("offline");
  let release!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = updates.check(true);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  sharedPluginUpdateChecks(f.manager.imports).observe(f.plugin)(
    f.plugin.revision,
  );
  expect(updates.snapshot()).toEqual([]);
  release(f.preview);
  await pending;
  expect(updates.snapshot()).toEqual([]);
  updates.dispose();
});

it("keeps Git discovery and later rounds independent of a stalled folder probe", async () => {
  const f = fixture();
  const state = f.get();
  if (state.status !== "ready") throw new Error("fixture catalog missing");
  const folder = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "folder" },
    updateSource: { root: "/plugins", path: "." },
  };
  let release!: (revision: string) => void;
  Object.assign(f.imports, {
    checkFolder: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    ),
  });
  f.set({
    ...state,
    catalog: { ...state.catalog, plugins: [folder, f.plugin] },
  });
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  try {
    await vi.waitFor(() => expect(f.checkGit).toHaveBeenCalledOnce());
    await pending;
    await updates.check(true);
    expect(f.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    release("new");
    await pending;
    updates.dispose();
  }
});

it("checks a newly attached Git source after an older batch reserved a source-less observation", async () => {
  const f = fixture();
  const state = f.get();
  if (state.status !== "ready") throw new Error("fixture catalog missing");
  const source = f.plugin.updateSource;
  if (!source) throw new Error("fixture source missing");
  const unsourced = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "unsourced" },
    updateSource: null,
  };
  f.set({
    ...state,
    catalog: { ...state.catalog, plugins: [f.plugin, unsourced] },
  });
  let release!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise<ImportPreview>((resolve) => {
        release = resolve;
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const registered = { ...unsourced, updateSource: source };
    f.preview.candidates.push({
      ...f.candidate,
      manifest: registered.manifest,
    });
    sharedPluginUpdateChecks(f.manager.imports).observe(registered)(
      registered.revision,
    );
    f.set({
      ...state,
      catalog: { ...state.catalog, plugins: [f.plugin, registered] },
    });
    const retry = updates.check();
    release(f.preview);
    await Promise.all([pending, retry]);
    expect(
      pluginUpdateAvailable(
        sharedPluginUpdateChecks(f.manager.imports).snapshot(),
        registered,
      ),
    ).toBe(true);
    expect(
      updates.snapshot().find((update) => update.id === registered.manifest.id)
        ?.candidate?.revision,
    ).toBe("new");
  } finally {
    release?.(f.preview);
    await pending;
    updates.dispose();
  }
});

it.each(["removed", "disabled", "replaced"] as const)(
  "does not authorize a queued Git source after it is %s",
  async (change) => {
    const f = fixture();
    const state = f.get();
    if (state.status !== "ready") throw new Error("fixture catalog missing");
    const queued = {
      ...f.plugin,
      manifest: { ...f.plugin.manifest, id: "queued" },
      updateSource: {
        repository: "https://example.com/queued.git",
        reference: "main",
        path: ".",
      },
    };
    const later = {
      ...queued,
      manifest: { ...queued.manifest, id: "later" },
      updateSource: {
        ...queued.updateSource,
        repository: "https://example.com/later.git",
      },
    };
    f.set({
      ...state,
      catalog: { ...state.catalog, plugins: [f.plugin, queued, later] },
    });
    let release!: (preview: ImportPreview) => void;
    f.checkGit.mockImplementationOnce(
      () =>
        new Promise<ImportPreview>((resolve) => {
          release = resolve;
        }),
    );
    const updates = createPluginUpdates(f.manager, f.authorize);
    const pending = updates.check();
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const changed =
        change === "disabled"
          ? { ...queued, updateChecks: false }
          : {
              ...queued,
              updateSource: {
                ...queued.updateSource,
                repository: "https://example.com/replacement.git",
              },
            };
      f.set({
        ...state,
        catalog: {
          ...state.catalog,
          plugins: [
            f.plugin,
            ...(change === "removed" ? [] : [changed]),
            later,
          ],
        },
      });
      const retry = updates.check();
      release(f.preview);
      await Promise.all([pending, retry]);
      expect(f.authorize).not.toHaveBeenCalledWith(
        queued.updateSource.repository,
      );
      expect(f.authorize).toHaveBeenCalledWith(later.updateSource.repository);
      if (change === "replaced")
        expect(f.authorize).toHaveBeenCalledWith(
          changed.updateSource.repository,
        );
    } finally {
      release?.(f.preview);
      await pending;
      updates.dispose();
    }
  },
);

it.each(["review", "details"])(
  "retains the latest candidate after a newer %s result without installing",
  async (entry) => {
    const f = fixture();
    const updates = createPluginUpdates(f.manager, f.authorize);
    await updates.check();
    const first = updates.snapshot()[0];
    if (!first) throw new Error("Expected update");
    updates.later(first);
    const candidate = {
      ...f.candidate,
      revision: "newer",
      manifest: { ...f.candidate.manifest, name: "New notes" },
      readmeRevision: "new-readme",
    };
    const checks = sharedPluginUpdateChecks(f.manager.imports);
    if (entry === "review")
      checks.observe(f.plugin)(candidate.revision, null, candidate);
    else {
      f.checkGit.mockResolvedValueOnce({
        ...f.preview,
        candidates: [candidate],
      });
      await checks.check(f.plugin, f.authorize);
    }
    expect(updates.snapshot()).toEqual([{ ...first, candidate }]);
    const latest = updates.snapshot()[0];
    if (!latest) throw new Error("Expected latest update");
    expect(updates.hidden(latest)).toBe(false);
    expect(pluginUpdateAvailable(checks.snapshot(), f.plugin)).toBe(true);
    await updates.check();
    expect(updates.snapshot()[0]?.candidate).toEqual(candidate);
    expect(f.imports.install).not.toHaveBeenCalled();
    updates.dispose();
  },
);

it("drops a Git discovery result when the installation switches to a pinned URL", async () => {
  const f = fixture();
  let finish!: (preview: ImportPreview) => void;
  f.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const updates = createPluginUpdates(f.manager, f.authorize);
  const pending = updates.check();
  await vi.waitFor(() => expect(f.checkGit).toHaveBeenCalledOnce());
  const configuration = f.get();
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const pinned: PluginInfo = {
    ...f.plugin,
    updateSource: {
      url: "https://plugins.example.org/plugin.json",
      sha256: "a".repeat(64),
    },
  };
  f.set({
    ...configuration,
    catalog: { ...configuration.catalog, plugins: [pinned] },
  });
  finish(f.preview);
  await pending;
  await updates.check(true);
  expect(updates.snapshot()).toEqual([]);
  expect(
    pluginUpdateAvailable(
      sharedPluginUpdateChecks(f.manager.imports).snapshot(),
      pinned,
    ),
  ).toBe(false);
  expect(f.checkGit).toHaveBeenCalledOnce();
  expect(f.authorize).toHaveBeenCalledOnce();
  updates.dispose();
});

it.each(["authorization", "acquisition"] as const)(
  "starts folder discovery while an earlier Git %s is held",
  async (phase) => {
    const f = fixture();
    const configuration = f.get();
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    const folder = {
      ...f.plugin,
      manifest: { ...f.plugin.manifest, id: "example.folder" },
      updateSource: { root: "/plugins/folder", path: "." },
    };
    const checkFolder = vi.fn(async () => "folder-new");
    Object.assign(f.imports, { checkFolder });
    f.set({
      ...configuration,
      catalog: { ...configuration.catalog, plugins: [f.plugin, folder] },
    });
    let release!: () => void;
    const held = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    if (phase === "authorization") f.authorize.mockReturnValueOnce(held);
    else
      f.checkGit.mockImplementationOnce(async () => {
        await held;
        return f.preview;
      });
    const updates = createPluginUpdates(f.manager, f.authorize);
    const pending = updates.check();
    try {
      await vi.waitFor(() =>
        expect(
          phase === "authorization" ? f.authorize : f.checkGit,
        ).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() =>
        expect(
          pluginUpdateAvailable(
            sharedPluginUpdateChecks(f.manager.imports).snapshot(),
            folder,
          ),
        ).toBe(true),
      );
      expect(checkFolder).toHaveBeenCalledExactlyOnceWith(folder.manifest.id);
    } finally {
      release();
      await pending;
      updates.dispose();
    }
  },
);
