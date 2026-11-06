import type { PluginModule } from "../../plugins/api";
import { hideMutedRows } from "./muted";

export const inject = ["relay"];

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.reflect.get("sidebarRows")?.register(hideMutedRows(ctx.relay));
};
