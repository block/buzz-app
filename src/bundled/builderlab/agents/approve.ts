import type { Agents } from "../../../features/agents/service";
import type { BuilderlabSession } from "../session";
import type { AgentClient, RemoteAgent } from "./client";

const BUILDERLAB_TYPE = "block.builderlab/builderlab";

/** Sets up an agent that another agent requested, on the model it already
 * has or else Builderlab's default, with the instructions the owner reviewed. */
export async function approveRequested(
  client: AgentClient,
  session: BuilderlabSession,
  agents: Pick<Agents, "adopt">,
  agent: RemoteAgent,
  instructions: string,
  signal: AbortSignal,
) {
  const { subject } = session.credential().account;
  const chosen =
    agent.modelSelectionStatus === "valid" &&
    agent.modelId &&
    agent.reasoningEffort
      ? { modelId: agent.modelId, reasoningEffort: agent.reasoningEffort }
      : (await client.modelCatalog(signal)).recommended;
  if (!chosen) throw new Error("Builderlab has no default model to use.");
  await agents.adopt({
    type: BUILDERLAB_TYPE,
    name: agent.name,
    pubkey: agent.pubkey,
    config: { instructions, ...chosen, subject },
  });
}

/** Deletes the request, through Agents when an approval attempt kept it there. */
export async function rejectRequested(
  client: AgentClient,
  agents: Pick<Agents, "find" | "remove">,
  agent: RemoteAgent,
  signal: AbortSignal,
) {
  if (agents.find(agent.pubkey)) await agents.remove(agent.pubkey);
  else await client.delete(agent, signal);
}
