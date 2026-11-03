import type { PluginModule } from "../../plugins/api";
import { ImportConsentCard, ImportProgressBanner } from "./ImportCards";

export const manifest = {
  id: "buzz.conversation-import",
  name: "Conversation import",
  apiVersion: 1,
  description:
    "Consent cards and progress for conversations imported from other tools.",
} as const;

export const inject = ["conversation", "relay", "conversationImport"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerMessage({
    id: "proposal",
    title: "Conversation import proposal",
    matches: (message) => message.importRecord?.type === "proposal",
    component: ({ message }) => (
      <ImportConsentCard
        message={message}
        relay={ctx.relay}
        service={ctx.conversationImport}
      />
    ),
  });
  ctx.conversation.registerAccessory({
    id: "progress",
    title: "Import progress",
    component: ({ channelId, threadRootId }) =>
      threadRootId ? null : (
        <ImportProgressBanner
          channelId={channelId}
          service={ctx.conversationImport}
        />
      ),
  });
};
