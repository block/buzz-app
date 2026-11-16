import { enableThreadTitles } from "../../features/messages/thread-title-store";
import type { PluginModule } from "../../plugins/api";
import { TitleAccessory } from "./TitleAccessory";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.effect(() => enableThreadTitles());
  ctx.conversation.registerAccessory({
    id: "thread-title",
    title: "Thread title",
    placement: "message",
    component: TitleAccessory,
  });
};
