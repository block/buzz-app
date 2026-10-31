// FOUNDATION: Compose the page that runs agents apart from the screens: the
// Runner and the plugins' agent entries. It reaches the Manager, in the
// screens' page, over the agents port. It shows nothing, and keeps nothing
// on the device for the screens: their communities, outbox and history stay
// theirs.
import { Context } from "@deepseek-ai/cordis";
import { bundledPlugins } from "../bundled";
import { AGENTS_WEBVIEW } from "../features/agents/apart";
import { eventPort } from "../features/agents/event-port";
import { lanes } from "../features/agents/lanes";
import { link, type LinkPort } from "../features/agents/link";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import { nativeAgents } from "../features/agents/native";
import { followPage } from "../features/agents/page-link";
import { serveActivity } from "../features/agents/runner-link";
import {
  AgentsRunnerService,
  RunnerAgents,
} from "../features/agents/runner-service";
import { agentStorage, readAgentStorage } from "../features/agents/state";
import { pageCommunities } from "../features/communities/page";
import { AgentProtectionService } from "../features/agent-protection/service";
import { DecisionsService } from "../features/decisions/service";
import { HostService } from "../features/host/service";
import { connectNativeTransport } from "../features/relay/native";
import { createPluginManager } from "../plugins/manager";
import { withTimeout } from "../plugins/timeout";

export function createAgentsHost(
  port: LinkPort = eventPort(AGENTS_WEBVIEW, "main"),
) {
  const ctx = new Context();
  new HostService(ctx);
  // Each agent entry starts once the Runner gives it `ctx.agents`.
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
    parts: "agent",
  });
  const localActivity = createLocalAgentActivity();
  const decisions = new DecisionsService(ctx);
  const communities = pageCommunities(ctx, connectNativeTransport, {
    localAgents: localActivity.reader,
  });
  const { agents: agentsLane, page: pageLane } = lanes(port, [
    "agents",
    "page",
  ]);
  const page = link(pageLane, serveActivity(localActivity.reader));
  let disposed = false;
  let started = false;
  // The screens' page loads agent storage first, and moves what localStorage
  // had into it; then this page reads it, and starts the Runner.
  const start = (storage: "files" | "local") =>
    (storage === "files" ? readAgentStorage() : Promise.resolve()).then(() => {
      if (disposed) return;
      const native = nativeAgents();
      // Protection plugins' agent entries register their checkers here,
      // where the agents they check run. Their UI entries save policies from
      // the screens' page.
      const protection = new AgentProtectionService(
        ctx,
        () => ({
          owner: communities.snapshot().viewer,
          agents: runner.running(),
          types: runner.agentTypes(),
        }),
        {
          read: async (owner) => {
            if (!native?.protectionDefaults)
              throw new Error("Native agent protection is unavailable");
            return native.protectionDefaults(owner);
          },
          save: async (owner, revision, provider, policy) => {
            if (!native?.setProtectionDefaults)
              throw new Error("Native agent protection is unavailable");
            await native.setProtectionDefaults(
              owner,
              revision,
              provider,
              policy,
            );
          },
          update: (pubkey, revision, provider, policy) =>
            runner.protect(pubkey, revision, provider, policy),
        },
      );
      const runner: AgentsRunnerService = new AgentsRunnerService(
        ctx,
        agentsLane,
        {
          communities,
          native,
          storage: agentStorage(),
          localActivity,
          decisions,
          protection: (agent) => protection.bind(agent),
        },
      );
      new RunnerAgents(ctx, runner);
    });
  const stopFollowing = followPage(page, (state) => {
    communities.follow(state.communities);
    if (started) return;
    started = true;
    start(state.storage).catch((error: unknown) => {
      console.error("Agents could not start", error);
    });
  });
  let disposal: Promise<void> | undefined;
  return {
    dispose() {
      disposed = true;
      stopFollowing();
      page.close();
      agentsLane.close();
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "Agents cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}
