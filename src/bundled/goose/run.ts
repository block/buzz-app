// The part of the goose agent type that runs agents, without its views.
import type { AgentType } from "../../features/agents/service";
import { type Config, config, type GooseRuntime } from "./runtime";
import { syncedSettingsSchema, withSyncedSettings } from "./settings";

/** A turn's run returns once goose has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const gooseRun = (
  runtime: GooseRuntime,
): Pick<
  AgentType<Config>,
  | "restart"
  | "sessionControls"
  | "run"
  | "runOnce"
  | "timeoutMs"
  | "syncedSettings"
> => ({
  restart: {
    outdated: (pubkey, settings) => runtime.outdated(pubkey, settings),
    apply: (pubkey, applied) => runtime.restart(pubkey, applied),
    subscribe: (listener) => runtime.subscribe(listener),
  },
  sessionControls: {
    scope: (agent) => config(agent.config).scope,
    state: (agent, place) => runtime.sessionState(agent, place),
    run: (agent, place, action) => runtime.session(agent, place, action),
    subscribe: (listener) => runtime.subscribe(listener),
  },
  run: (delivery) => runtime.run(delivery),
  runOnce: (turn) => runtime.runOnce(turn),
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
});
