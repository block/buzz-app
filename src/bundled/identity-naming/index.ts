import type { PluginModule } from "../../plugins/api";
import { resolveIdentityNames } from "../../features/identity-names/policy";
export const inject = ["identityNames"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.identityNames.register({
    id: "human-first",
    resolve: resolveIdentityNames,
  });
};
