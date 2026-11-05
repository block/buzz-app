import type { PluginModule } from "../../plugins/api";
import { SmileyStickerIcon } from "../../shared/design-system/icons";
import { StickerDialog, stickerSource } from "./StickerDialog";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerMessageAction({
    id: "make-sticker",
    title: "Make sticker",
    icon: () => <SmileyStickerIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      !!stickerSource(message) &&
      !!session.emoji.add &&
      !!session.emoji.upload &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)),
    component: StickerDialog,
  });
};
