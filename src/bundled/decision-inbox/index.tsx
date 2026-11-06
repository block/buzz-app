import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import { ListChecksIcon } from "../../shared/design-system/icons";
import { DecisionDialog } from "./DecisionDialog";
import { DecisionInboxPage } from "./DecisionInboxPage";

export const inject = ["pages", "relay", "navigation", "conversation"];

export const apply: PluginModule["apply"] = (ctx) => {
  const current = (session: RelaySession) => {
    const connection = ctx.relay.snapshot();
    return (
      connection.status === "ready" &&
      connection.viewer === session.viewer &&
      connection.scope === session.scope &&
      !!session.viewer &&
      !!session.scope
    );
  };
  ctx.pages.register({
    id: "decision-inbox",
    title: "Decision Inbox",
    layout: "workspace",
    primary: true,
    component: () => (
      <DecisionInboxPage relay={ctx.relay} navigator={ctx.navigation} />
    ),
  });
  ctx.conversation.registerMessageAction({
    id: "save-decision",
    title: "Save to Decision Inbox",
    icon: () => <ListChecksIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      current(session) &&
      /^[0-9a-f]{64}$/i.test(message.id) &&
      !!message.channelId &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)) &&
      !message.membership &&
      !message.huddle,
    component: ({ message, session, close }) => (
      <DecisionDialog
        scope={session.scope}
        message={message}
        current={() => current(session)}
        close={close}
      />
    ),
  });
};
