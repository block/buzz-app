import { createPluginStorage, type PluginStorage } from "./storage";
import * as React from "react";
import { PluginRuntime } from "./runtime";
import type { Context } from "@deepseek-ai/cordis";
import type { PluginManifest, PluginModule } from "./api";
import { createModuleLoader } from "./modules";
import { withTimeout } from "./timeout";
import type {
  StorageResult,
  ConfigurationState,
  ManagementAction,
} from "./types";

export type BundledPlugin = { manifest: PluginManifest; module: PluginModule };

// One configuration observer drives activation, whether or not Settings is mounted.
export function createPluginManager(
  ctx: Context,
  {
    bundled,
    storage = createPluginStorage(() =>
      bundled.map(({ manifest }) => ({
        manifest,
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        error: null,
      })),
    ),
  }: {
    bundled: readonly BundledPlugin[];
    storage?: PluginStorage | undefined;
  },
) {
  ctx.provide("react", React);
  const runtime = new PluginRuntime(
    ctx,
    createModuleLoader(
      Object.fromEntries(
        bundled.map(({ manifest, module }) => [manifest.id, module]),
      ),
      storage.readModule,
    ),
  );
  let configuration: ConfigurationState = { status: "loading" };
  let busy = false;
  let error: string | null = null;
  let refreshError: string | null = null;
  let closed = false;
  let changes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const listeners = new Set<() => void>();
  const read = () => ({
    configuration,
    activation: runtime.snapshot(),
    busy,
    error,
    refreshError,
  });
  let snapshot = read();
  const publish = () => {
    if (closed) return;
    snapshot = read();
    for (const listener of listeners) listener();
  };
  const unsubscribe = runtime.subscribe(publish);

  function accept(next: StorageResult) {
    if (JSON.stringify(configuration) === JSON.stringify(next) && !refreshError)
      return;
    configuration = next;
    refreshError = null;
    const desired =
      next.status === "ready"
        ? next.catalog.plugins.filter(
            (plugin) =>
              plugin.enabled &&
              !(next.externalPluginsPaused && plugin.source === "external"),
          )
        : [];
    runtime.reconcile(desired);
    publish();
  }
  async function refresh() {
    const before = changes;
    try {
      if (busy) return;
      const next = await withTimeout(
        storage.getCatalog(),
        "Plugin storage did not respond within 10 seconds",
      );
      if (!closed && before === changes) accept(next);
    } catch (reason) {
      if (!closed && before === changes) {
        if (configuration.status === "ready") {
          refreshError = String(reason);
          publish();
        } else
          accept({
            status: "recovery",
            reason: String(reason),
            canReset: false,
          });
      }
    } finally {
      if (!closed) timer = setTimeout(() => void refresh(), 1000);
    }
  }
  async function update(operation: () => Promise<StorageResult>) {
    if (busy || closed) return false;
    busy = true;
    changes++;
    error = null;
    publish();
    try {
      const next = await withTimeout(
        operation(),
        "Plugin storage did not respond within 10 seconds",
      );
      if (!closed) accept(next);
      return !closed;
    } catch (reason) {
      if (!closed) error = String(reason);
      return false;
    } finally {
      changes++;
      busy = false;
      publish();
    }
  }
  void refresh();
  return {
    snapshot: () => snapshot,
    startup: () => configuration.status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    imports: storage.imports,
    installImport: (token: string, path: string) =>
      update(() => {
        if (!storage.imports)
          throw new Error("Plugin imports require the desktop app");
        return storage.imports.install(token, path);
      }),
    change: (action: ManagementAction, id: string) =>
      update(() => storage.changePlugin(action, id)),
    retry: () => update(storage.getCatalog),
    recover: () => update(storage.recoverSettings),
    dismissError: () => {
      error = null;
      publish();
    },
    async dispose() {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      listeners.clear();
      await runtime.dispose();
    },
  };
}
export type PluginManager = ReturnType<typeof createPluginManager>;
