// Claude agents: an agent type whose agents are Claude sessions on
// this computer. Each conversation the agent is in is one continuing session;
// Claude answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { ownerReads } from "../../features/agents/reads";
import type { PluginModule } from "../../plugins/api";
import { claudeRun, TYPE_ID } from "./run";
import { ClaudeRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { Create, createTabs } from "./tabs";

export { TYPE_ID };

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `claude`, and setup and file uploads run
  // `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/${TYPE_ID}`;
  const spawn = host.spawn?.bind(host);
  const setup = new ClaudeSetup(spawn);
  const runtime = new ClaudeRuntime(host, (pubkey) =>
    ownerReads(agents.relay(pubkey), pubkey),
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    // Agents that stop running, the app signing out included, stop their
    // processes; switching communities does not.
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  // One spare session waits for whichever running agent needs it next.
  if (spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
      setup.dispose();
    });
  }

  const { ClaudeTab, SettingsTab } = createTabs({ setup, runtime });
  agents.register<Config>({
    id: TYPE_ID,
    title: "Claude",
    description:
      "Claude on this computer. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    summary: (agent) => config(agent.config).model || "Claude",
    tabs: [
      { id: "claude", title: "Claude", component: ClaudeTab },
      { id: "settings", title: "Settings", component: SettingsTab },
    ],
    ...claudeRun(runtime),
  });
};
