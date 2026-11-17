import type { PluginModule } from "../../plugins/api";
import { workflowRoute } from "../../features/workflows/route";
import { WorkflowsPage } from "./WorkflowsPage";
export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.pages.register({
    id: "workflows",
    title: "Workflows",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: (params) => !!workflowRoute(params) },
    component: ({ navigation }) => (
      <WorkflowsPage
        relay={relay}
        navigation={navigation}
        navigator={ctx.navigation}
      />
    ),
  });
};
