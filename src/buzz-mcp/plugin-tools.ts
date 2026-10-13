// Plugins' tools beside the Buzz tools: what a session is offered, and how a
// call reaches the plugin. Only the in-app harnesses offer them; the standalone
// `buzz-mcp` server and hosted agents have no plugins.
import type {
  AgentToolCaller,
  RegisteredAgentTool,
} from "../features/agents/service";
import { ATTENTION_TOOLS } from "./attention";
import { type Tool, TOOLS } from "./tools";

/** Buzz's own names, attention's included, so a plugin can never take one. */
const RESERVED = new Set(
  [...TOOLS, ...ATTENTION_TOOLS].map(({ name }) => name),
);

/** The tools to offer: one per name, the lowest contribution key winning, so
 * activation order never decides which plugin answers. */
export function pluginTools(
  registered: readonly RegisteredAgentTool[],
): readonly RegisteredAgentTool[] {
  const byName = new Map<string, RegisteredAgentTool>();
  for (const tool of registered) {
    if (RESERVED.has(tool.id)) continue;
    const held = byName.get(tool.id);
    if (!held || tool.key < held.key) byName.set(tool.id, tool);
  }
  return [...byName.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** As a session lists it. */
export const listed = (tool: RegisteredAgentTool): Tool => ({
  name: tool.id,
  description: tool.description,
  inputSchema: tool.inputSchema as Tool["inputSchema"],
});

/** Runs plugin tool `name`, or undefined when no active plugin has one, as
 * after its plugin was turned off mid-session. */
export function callPluginTool(
  registered: readonly RegisteredAgentTool[],
  name: string,
  args: Readonly<Record<string, unknown>>,
  caller: AgentToolCaller,
): Promise<string> | undefined {
  return pluginTools(registered)
    .find((tool) => tool.id === name)
    ?.call(args, caller);
}
