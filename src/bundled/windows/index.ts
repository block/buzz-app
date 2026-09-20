// The switch for detaching tabs into their own desktop windows. The windowing
// runtime is host-owned (src/features/windows, src-tauri/src/windows.rs); this
// plugin turns it on, and disabling it gathers every tab back into main.
import type { PluginModule } from "../../plugins/api";

export const inject = ["windows"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.effect(() => ctx.windows.enable());
};
