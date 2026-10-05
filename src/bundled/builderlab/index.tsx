import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { Login } from "./Login";
import { createSession } from "./session";

export const inject = ["settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!isTauri()) return;
  const session = createSession();
  ctx.effect(() => () => session.dispose());
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => <Login session={session} active={active} />,
  });
};
