import type { PluginModule } from "../../plugins/api";
import { Bestie } from "./Bestie";
import { createBestieCall } from "./call";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const call = createBestieCall(ctx.relay);
  ctx.effect(() => () => call.dispose());
  ctx.panels.register({
    id: "companion",
    title: "Bestie",
    matches: () => false,
    launcher: { icon: "/bestie.png", target: "" },
    component: () => (
      <Bestie
        call={call}
        available={import.meta.env.VITE_BESTIE_REALTIME === "1"}
      />
    ),
  });
};
