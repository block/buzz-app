import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));

const { createPluginStorage } = await import("./storage");
beforeEach(() => invoke.mockReset());

it("passes the pinned commit to the native Git import and the policy through the catalog", async () => {
  const storage = createPluginStorage(() => []);
  await storage.imports?.git("https://example.com/plugins", "v1", undefined, {
    commit: "a".repeat(40),
  });
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/plugins",
    reference: "v1",
    authorization: undefined,
    commit: "a".repeat(40),
  });
  await storage.imports?.checkGit("https://example.com/plugins", "v1");
  expect(invoke).toHaveBeenLastCalledWith("plugin_import_git", {
    repository: "https://example.com/plugins",
    reference: "v1",
    authorization: undefined,
    checkOnly: true,
  });
  const ready = {
    status: "ready",
    catalog: { profile: "p", location: "l", plugins: [] },
    externalPluginsPaused: false,
    managed: {
      status: "ready",
      path: "/m.json",
      source: "Org",
      plugins: [],
      problems: [],
    },
  };
  invoke.mockResolvedValueOnce(ready as never);
  await expect(storage.getCatalog()).resolves.toEqual(ready);
});

it("dispatches administrative cleanup without arguments and preserves the pre-start snapshot", async () => {
  const storage = createPluginStorage(() => []);
  const status = { pending: 2, running: 0, unreadable: true };
  invoke.mockResolvedValueOnce(status as never);
  await expect(storage.retryCredentialCleanup()).resolves.toEqual(status);
  expect(invoke).toHaveBeenLastCalledWith("plugin_credential_cleanup_retry");
  invoke.mockRejectedValueOnce(new Error("already running"));
  await expect(storage.retryCredentialCleanup()).rejects.toThrow(
    "already running",
  );
});

it("preserves native commit/problem and catalog cleanup fields through every mutation transport", async () => {
  const storage = createPluginStorage(() => []);
  const result = {
    status: "ready",
    catalog: {
      profile: "p",
      location: "l",
      plugins: [],
      credentialCleanup: { pending: 1, running: 1 },
    },
    externalPluginsPaused: false,
    committed: true,
    problem: "Plugin removed, but its files could not be deleted",
  };
  for (const mutation of [
    () => storage.changePlugin("remove", "example"),
    () => storage.reloadPlugin("example"),
    () => storage.recoverSettings(),
    () => storage.imports?.install("token", "."),
  ]) {
    invoke.mockResolvedValueOnce(result as never);
    await expect(mutation()).resolves.toEqual(result);
  }
});
