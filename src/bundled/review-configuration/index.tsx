import { ReviewUpdatesBadge } from "./ReviewUpdatesBadge";
import { messageRoute } from "./ReviewMessageDialog";
import { createAdmissionReader } from "./admission";
import { watchTriage } from "./triage-coordinator";
import { gitHubCli } from "../github/gh";
import { createPullReader, createPullStatusReader } from "./pull-facts";
import type { PluginModule } from "../../plugins/api";
import {
  ReviewConfigurationPage,
  reviewPageTitle,
  type ReviewPage,
} from "./ReviewConfigurationPage";

export const inject = ["pages", "relay", "navigation", "host", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { relay, navigation: navigator } = ctx;
  const gh = gitHubCli(ctx.host);
  const readPull = createPullReader(gh);
  const readStatus = createPullStatusReader(gh);
  const readAdmission = createAdmissionReader(gh);
  ctx.effect(() => {
    let bound: unknown;
    let release: (() => void) | undefined;
    const bind = () => {
      const connection = relay.snapshot();
      const next =
        connection.status === "ready" ? connection.session : undefined;
      if (next === bound) return;
      release?.();
      bound = next;
      release =
        next &&
        watchTriage(next, readPull, readAdmission, (name) => {
          const tool = ctx.agents.describeTool(name);
          if (!tool)
            throw new Error(
              "Review tools are unavailable. Update Buzz before continuing.",
            );
          if (tool.name === "pr_review_status_update") return tool.description;
          return `Tool: ${tool.name}\n${tool.description}\nArguments: ${JSON.stringify(tool.inputSchema)}`;
        });
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
    };
  });
  for (const page of ["configuration", "submit", "all"] satisfies ReviewPage[])
    ctx.pages.register({
      id: page,
      title: reviewPageTitle(page),
      layout: "workspace",
      ...(page === "all"
        ? { badge: () => <ReviewUpdatesBadge relay={relay} /> }
        : {}),
      primary: page !== "submit",
      placement: page === "submit" ? "sidebar" : "dock",
      route: { version: 1, validate: (params) => !!messageRoute(params) },
      component: ({ navigation }) => (
        <ReviewConfigurationPage
          page={page}
          relay={relay}
          navigator={navigator}
          navigation={navigation}
          readPull={readPull}
          readStatus={readStatus}
          readAdmission={readAdmission}
          describeTool={(name) => ctx.agents.describeTool(name)}
        />
      ),
    });
};
