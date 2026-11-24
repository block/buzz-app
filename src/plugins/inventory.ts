import { Service, type Context } from "@deepseek-ai/cordis";
import type { AdminAccessReader } from "../bundled/admin-access";
import type { PluginManager } from "./manager";
import {
  accessMessage,
  isRequiredPlugin,
  restrictedPlugin,
} from "./toggle-access";
import type { PluginInfo } from "./types";

export type InstalledPlugin = Readonly<{
  id: string;
  name: string;
  source: "built-in" | "add-on";
  enabled: boolean;
  blockedReason?: string;
}>;

export type PluginInventorySnapshot =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable"; message: string }>
  | Readonly<{ status: "ready"; plugins: readonly InstalledPlugin[] }>;

export type PluginInventory = Readonly<{
  snapshot(): PluginInventorySnapshot;
  subscribe(listener: () => void): () => void;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional desktop service, gated by the caller's reviewed host grant. */
    pluginInventory?: PluginInventory;
  }
}

const loading = Object.freeze({ status: "loading" });
const unavailable = Object.freeze({
  status: "unavailable",
  message:
    "Buzz couldn’t load installed plugins. Open Manage plugins for details.",
});
const denied = Object.freeze({
  status: "unavailable",
  message: "This plugin needs permission to view and change installed plugins.",
});

export function providePluginInventory(
  ctx: Context,
  manager: PluginManager,
  access: Pick<AdminAccessReader, "ensure" | "status" | "subscribe">,
): PluginInventory {
  function blockedReason(plugin: PluginInfo) {
    if (isRequiredPlugin(plugin)) return "Required by Buzz";
    if (!plugin.enabled && restrictedPlugin(plugin)) {
      return accessMessage(plugin, access.status(plugin.manifest.id));
    }
    return null;
  }

  let last: PluginInventorySnapshot = loading;
  function snapshot(): PluginInventorySnapshot {
    const { configuration } = manager.snapshot();
    if (configuration.status === "loading") return loading;
    if (configuration.status === "recovery") return unavailable;
    const plugins = configuration.catalog.plugins.map(
      (plugin): InstalledPlugin => {
        const reason = blockedReason(plugin);
        return Object.freeze({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          source: plugin.source === "bundled" ? "built-in" : "add-on",
          enabled: plugin.enabled,
          ...(reason && { blockedReason: reason }),
        });
      },
    );
    if (
      last.status === "ready" &&
      last.plugins.length === plugins.length &&
      last.plugins.every((previous, index) => {
        const current = plugins[index];
        return (
          current &&
          previous.id === current.id &&
          previous.name === current.name &&
          previous.source === current.source &&
          previous.enabled === current.enabled &&
          previous.blockedReason === current.blockedReason
        );
      })
    )
      return last;
    last = Object.freeze({ status: "ready", plugins: Object.freeze(plugins) });
    return last;
  }

  function authorized(caller: Context) {
    const owner = caller.pluginOwner;
    const { configuration } = manager.snapshot();
    return (
      owner &&
      configuration.status === "ready" &&
      configuration.catalog.plugins.some(
        (plugin) =>
          plugin.manifest.id === owner.id &&
          plugin.revision === owner.revision &&
          plugin.enabled &&
          plugin.manifest.host?.pluginInventory === true,
      )
    );
  }

  class InventoryService extends Service implements PluginInventory {
    constructor() {
      super(ctx, "pluginInventory");
    }

    snapshot() {
      return authorized(this.ctx) ? snapshot() : denied;
    }

    subscribe(listener: () => void) {
      const caller = this.ctx;
      if (!authorized(caller)) return () => {};
      const stop = caller.effect(() => {
        let previous = snapshot();
        const notify = () => {
          const current = authorized(caller) ? snapshot() : denied;
          if (current === previous) return;
          previous = current;
          try {
            listener();
          } catch (error) {
            caller
              .logger("pluginInventory")
              .warn("Inventory listener failed", error);
          }
        };
        const stops = [
          manager.subscribe(notify),
          access.subscribe(notify),
          access.ensure(),
        ];
        return () => {
          for (const release of stops) release();
        };
      });
      return () => void stop();
    }

    async setEnabled(id: string, enabled: boolean) {
      const caller = this.ctx;
      if (
        !authorized(caller) ||
        !caller.pluginOwner ||
        !caller.pluginStatus.isActive(
          caller.pluginOwner.id,
          caller.pluginOwner.revision,
        )
      ) {
        throw new Error(denied.message);
      }
      if (typeof id !== "string" || typeof enabled !== "boolean") {
        throw new Error("Invalid plugin status change");
      }
      const { configuration, busy } = manager.snapshot();
      const plugin =
        configuration.status === "ready"
          ? configuration.catalog.plugins.find(
              (item) => item.manifest.id === id,
            )
          : undefined;
      if (!plugin) throw new Error("Plugin is no longer installed");
      if (plugin.enabled === enabled) return;
      const reason = blockedReason(plugin);
      if (reason) throw new Error(reason);
      if (busy) throw new Error("Another plugin change is in progress");
      if (!(await manager.change(enabled ? "enable" : "disable", id))) {
        throw new Error(
          "Buzz could not change the plugin status. Open Manage plugins for details.",
        );
      }
      const current = snapshot();
      if (
        current.status !== "ready" ||
        !current.plugins.some(
          (item) => item.id === id && item.enabled === enabled,
        )
      )
        throw new Error("Buzz could not confirm the plugin status");
    }
  }

  return new InventoryService();
}
