import { createNameProvider } from "./directory";
import { resolveIdentityNames } from "./policy";
import type { AgentControl } from "../agents/control";
export const defaultNamingPolicy = {
  id: "human-first",
  resolve: resolveIdentityNames,
};
export function createAgentDirectory(
  control?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
) {
  return createNameProvider(defaultNamingPolicy, control);
}
export const agentDirectory = createAgentDirectory();
