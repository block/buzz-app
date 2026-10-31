// Pi agents: an agent type whose agents run on Pi durable on this computer,
// with any provider Pi supports. One Pi host runs them all, each with its own
// storage; each conversation the agent is in is one continuing, durable Pi
// conversation. Pi answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import { repositoriesContext } from "../../features/communities/repositories";
import type { PluginModule } from "../../plugins/api";
import { PiLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, PiRuntime } from "./runtime";
import { linkPi, servePi } from "./exposed";
import { createTabs } from "./tabs";

export const TYPE_ID = "pi";
/** A turn's run returns once Pi has it, so this bounds only the hand-over,
 * which includes the first install of Pi's packages. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start the Pi host; no unusable type elsewhere.
  if (!isTauri()) return;
  ctx.agents.present<Config>(TYPE_ID, (runtime) => {
    const { ActivityTab, Create, CreateModel, SettingsTab } = createTabs(
      linkPi(runtime),
    );
    return {
      icon: PiLogoIcon,
      Create,
      CreateModel,
      importShared: (source) =>
        source.runtime === "pi"
          ? {
              ...DEFAULT_CONFIG,
              model: source.model,
              provider: source.provider ?? "",
            }
          : undefined,
      exportShared: (saved) => {
        const { provider, model } = config(saved);
        return { runtime: "pi", ...(provider && { provider }), model };
      },
      tabs: [
        {
          id: "settings",
          title: "Settings",
          role: "settings",
          splitSettings: true,
          component: SettingsTab,
        },
        {
          id: "activity",
          title: "Activity",
          role: "activity",
          component: ActivityTab,
        },
      ],
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
      summary: (agent) => {
        const { model, provider } = config(agent.config);
        return [provider, model].filter(Boolean).join(" · ") || "Pi";
      },
      sessionScope: (agent) => config(agent.config).scope,
    };
  });
};

// The runtime, which runs where the agents do.
export const agent: NonNullable<PluginModule["agent"]> = {
  inject: ["agents", "host"],
  apply: (ctx) => applyAgent(ctx),
};
function applyAgent(ctx: Parameters<PluginModule["apply"]>[0]) {
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.pi"}/${TYPE_ID}`;
  const runtime = new PiRuntime(
    host,
    (key) => ownerReads(agents.relay(key), pubkeyOf(key)),
    (key, signal) => agents.core(key, signal),
    () => agents.tools(),
    repositoriesContext,
    (key) => agents.handle(key),
    async (agent, session, event, input) => {
      return (
        (await agents.dispatchHook(
          typeKey,
          event,
          input,
          { agent, session },
          { accepts: (output) => output != null, milliseconds: 25000 },
        )) ?? null
      );
    },
    (key, listener) => agents.relay(key)?.subscribe(listener) ?? (() => {}),
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  if (host.spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    hooks: { events: ["beforeTool", "afterTool"] },
    title: "Pi",
    description:
      "Pi on this computer, with any provider Pi supports. Each thread it is mentioned in is one continuing conversation.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    expose: servePi(runtime.setup, runtime),
    ...(host.spawn && {
      usage: (agent, { since, signal }) =>
        runtime.usage(agent.key, since, signal),
    }),
    sessions: {
      list: (key) => runtime.sessions(key),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    sessionControls: {
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action) => runtime.session(agent, place, action),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    models: (agent) => runtime.models(agent),
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
  });
}
