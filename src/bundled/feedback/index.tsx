import type { PluginModule } from "../../plugins/api";
import { FeedbackDialog } from "./FeedbackDialog";

export const inject = ["accountActions", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.accountActions.register({
    id: "send",
    title: "Send feedback",
    component: (props) => <FeedbackDialog {...props} relay={relay} />,
  });
};
