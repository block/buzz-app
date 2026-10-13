// The part of the Codex agent type that runs agents, without its views: the
// desktop app registers it with its tabs, and a standalone host runs it alone.
import type { AgentType } from "../../features/agents/service";
import type { Config } from "./config";
import type { CodexRuntime } from "./runtime";

export const TYPE_ID = "codex";
/** A turn's run returns once Codex has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const codexRun = (
  runtime: CodexRuntime,
): Pick<AgentType<Config>, "models" | "run" | "timeoutMs"> => ({
  models: (agent) => runtime.preview(agent),
  run: (delivery) => runtime.run(delivery),
  timeoutMs: HANDOVER_MS,
});
