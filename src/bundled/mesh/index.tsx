import type { PluginModule } from "../../plugins/api";
import { nativeBridge } from "./bridge";
import { MeshPage } from "./MeshPage";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  // The engine is native-only; a browser-only host has nothing to drive.
  if (!nativeBridge.available) return;
  ctx.pages.register({
    id: "mesh",
    title: "Mesh",
    layout: "workspace",
    component: () => <MeshPage bridge={nativeBridge} />,
  });
};
