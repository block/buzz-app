// The part of the Claude agent type that runs agents, without its views: the
// desktop app registers it with its tabs, and a standalone host runs it alone.
import type { AgentType } from "../../features/agents/service";
import type { ClaudeRuntime, Config } from "./runtime";

export const TYPE_ID = "claude-code";
/** A turn's run returns once Claude has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const claudeRun = (
  runtime: ClaudeRuntime,
): Pick<AgentType<Config>, "models" | "run" | "timeoutMs"> => ({
  models: (agent) => runtime.models(agent.pubkey),
  run: (delivery) => runtime.run(delivery),
  timeoutMs: HANDOVER_MS,
});
