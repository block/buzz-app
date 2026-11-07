import type { PluginModule } from "../../plugins/api";
import { ChartBarIcon } from "../../shared/design-system/icons";
import { TodaySpend } from "./TodaySpend";
import { todayStore } from "./today";
import { UsagePage } from "./UsagePage";

export const inject = ["settingsCards", "agents", "navigation", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, navigation } = ctx;
  ctx.settingsCards.register({
    id: "usage",
    title: "Usage",
    icon: ChartBarIcon,
    group: "Plugins",
    component: () => <UsagePage agents={agents} open={navigation.open} />,
  });
  const today = todayStore(agents);
  ctx.effect(() => () => today.dispose());
  ctx.conversation.registerTool({
    id: "today",
    title: "Today’s agent spend",
    placement: "send",
    // One amount per conversation: a thread beside its channel shows none.
    component: ({ threadRootId }) =>
      threadRootId ? null : <TodaySpend store={today} open={navigation.open} />,
  });
};
