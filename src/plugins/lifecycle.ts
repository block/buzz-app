import { invoke, isTauri } from "@tauri-apps/api/core";

// Native resource ownership is one activation, not a plugin ID or code hash.
export type PluginLifecycle = {
  begin(id: string, revision: string): Promise<number>;
  retire(id: string, activation: number): Promise<void>;
};
export function nativePluginLifecycle(): PluginLifecycle | undefined {
  if (!isTauri()) return undefined;
  return {
    begin: (id, revision) =>
      invoke("plugin_activation_begin", { id, revision }),
    retire: (id, activation) =>
      invoke("plugin_activation_retire", { id, activation }),
  };
}
