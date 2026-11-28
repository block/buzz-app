import type { PluginModule } from "../../plugins/api";
import { workflowLinks, workflowRoute } from "../../features/workflows/route";
import { WorkflowsPage } from "./WorkflowsPage";
export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  // Workflow messages link to this page only while it is registered.
  ctx.effect(() => workflowLinks.provide());
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
