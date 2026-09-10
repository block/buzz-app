import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Catalog,
  StorageResult,
  ManagementAction,
  PluginImports,
} from "./types";

export const desktop = isTauri();
const storageKey = "buzzodz.plugins.v1";

export function createPluginStorage(bundledCatalog: () => Catalog["plugins"]) {
  function webCatalog(): StorageResult {
    const catalog: Catalog = {
      profile: "browser",
      location: "This browser",
      plugins: bundledCatalog(),
    };
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || !("version" in value))
          throw new Error("Invalid browser plugin settings");
        if (
          value.version === 1 &&
          "enabled" in value &&
          typeof value.enabled === "boolean"
        ) {
          // This retired format controlled only the removed Welcome demo.
        } else if (
          value.version === 2 &&
          "enabled" in value &&
          value.enabled &&
          typeof value.enabled === "object" &&
          !Array.isArray(value.enabled) &&
          Object.values(value.enabled).every(
            (flag) => typeof flag === "boolean",
          )
        ) {
          const flags = value.enabled as Record<string, boolean>;
          for (const plugin of catalog.plugins)
            plugin.enabled = flags[plugin.manifest.id] ?? plugin.enabled;
        } else throw new Error("Invalid browser plugin settings");
      }
    } catch (error) {
      return { status: "recovery", reason: String(error), canReset: true };
    }
    return { status: "ready", catalog, externalPluginsPaused: false };
  }
  async function getCatalog(): Promise<StorageResult> {
    return desktop ? invoke("plugin_catalog") : webCatalog();
  }
  async function changePlugin(
    action: ManagementAction,
    id: string,
  ): Promise<StorageResult> {
    if (desktop) return invoke("plugin_change", { action, id });
    const result = webCatalog();
    if (result.status === "recovery")
      throw new Error("Recover browser settings before editing them");
    const { catalog } = result;
    if (
      !catalog.plugins.some((p) => p.manifest.id === id) ||
      (action !== "enable" && action !== "disable")
    )
      throw new Error("Bundled plugins can only be enabled or disabled");
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        enabled: Object.fromEntries(
          catalog.plugins.map((plugin) => [
            plugin.manifest.id,
            plugin.manifest.id === id ? action === "enable" : plugin.enabled,
          ]),
        ),
      }),
    );
    return webCatalog();
  }
  async function recoverSettings(): Promise<StorageResult> {
    if (desktop) return invoke("plugin_recover");
    const raw = localStorage.getItem(storageKey);
    if (raw !== null)
      localStorage.setItem(`${storageKey}.backup.${Date.now()}`, raw);
    localStorage.removeItem(storageKey);
    return webCatalog();
  }
  async function readModule(id: string, revision: string): Promise<string> {
    if (!desktop) throw new Error("Local plugins require the desktop app");
    return invoke("plugin_module", { id, revision });
  }

  const imports: PluginImports | undefined = desktop
    ? {
        folder: () => invoke("plugin_import_folder"),
        git: (repository, reference) =>
          invoke("plugin_import_git", { repository, reference }),
        install: (token, path) =>
          invoke("plugin_import_install", { token, path }),
        discard: (token) => invoke("plugin_import_discard", { token }),
      }
    : undefined;
  return { getCatalog, changePlugin, recoverSettings, readModule, imports };
}
export type PluginStorage = Omit<
  ReturnType<typeof createPluginStorage>,
  "imports"
> & {
  imports?: PluginImports | undefined;
};
