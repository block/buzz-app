// Amp agents: an agent type whose agents are Amp on this computer. Each
// conversation the agent is in is one Amp thread; Amp answers with the
// in-process Buzz tools, served to it over loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import { repositoriesContext } from "../../features/communities/repositories";
import type { PluginModule } from "../../plugins/api";
import { MODES } from "./amp";
import { AmpRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { Create, modeLabel, SettingsTab } from "./tabs";

export const TYPE_ID = "amp";
/** A turn's run returns once it is queued, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `amp`.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.amp"}/${TYPE_ID}`;
  const runtime = new AmpRuntime(
    host,
    agents.relay,
    (pubkey, signal) => agents.core(pubkey, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
  );
  if (host.spawn) {
    const sync = () => {
      const snapshot = agents.snapshot();
      if (snapshot.status === "loading") return;
      runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
    };
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    title: "Amp",
    description:
      "Amp on this computer. Each thread it is mentioned in is one continuing Amp thread.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => modeLabel(config(agent.config).mode),
    sessions: {
      list: (pubkey) => {
        const busy = new Set(runtime.sessions(pubkey).map(({ key }) => key));
        return runtime.conversations(pubkey).map(({ key, at }) => {
          const [channelId = key, root] = key.split("/");
          return {
            channelId,
            ...(root && { root }),
            at,
            ...(busy.has(key) && { status: "Working" }),
          };
        });
      },
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
    ],
    models: (agent) => ({
      current: config(agent.config).mode,
      models: MODES.map((mode) => ({
        id: mode,
        label: modeLabel(mode),
        efforts: [],
      })),
    }),
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
  });
};
