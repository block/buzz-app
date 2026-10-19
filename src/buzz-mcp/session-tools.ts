// What one agent session gets of the Buzz tools, whatever harness runs it:
// the tools to list, in groups, a note for the end of each turn, and the
// handler for every call. The attention tools are among them, and so are any
// tools plugins add. A harness passes all of this on without knowing what is
// in it.
import {
  ATTENTION_NONE,
  ATTENTION_OFF,
  ATTENTION_REVIEW,
} from "../features/agent-harness/attention-prompt";
import {
  ATTENTION_TOOLS,
  callAttentionTool,
  isAttentionTool,
} from "./attention";
import type { BuzzClient, Context } from "./client";
import { callTool, type Reply, TOOLS, type Tool } from "./tools";

/** A tool a plugin adds to every agent session in the app, listed in a
 * group of the tools its plugin adds. */
export type AddedTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Runs it as the agent working in `context`. A throw is a tool error for
   * the agent to correct. */
  call(
    client: BuzzClient,
    context: Context,
    args: Record<string, unknown>,
  ): Promise<Reply>;
}>;
type Listed = Pick<AddedTool, "name" | "description" | "inputSchema">;

export type BuzzSession = Readonly<{ tools: readonly Tool[] }>;

/** What every session of an agent in the app gets. It never changes with
 * the owner's attention setting, so a session (and its cached prompt prefix)
 * never needs replacing when attention is turned on or off: the attention
 * tools refuse calls while it is off, and `turnNote` says which it is. */
export const BUZZ_SESSION: BuzzSession = Object.freeze({
  tools: [...TOOLS, ...ATTENTION_TOOLS],
});

const listed = ({ name, description, inputSchema }: AddedTool): Listed => ({
  name,
  description,
  inputSchema,
});

/** Tools that one server (Claude) or namespace (Codex) lists. A harness that
 * can load tools on demand lists a `search` group's tools by name only, and
 * the model loads one when it needs it; `hint` is what it sees up front. */
export type ToolGroup = Readonly<{
  name: string;
  hint: string;
  load: "always" | "search";
  tools: readonly Listed[];
}>;
/** The groups a session lists: the Buzz tools, always loaded, then the
 * attention tools and each plugin's tools, loaded on search. `added` may name
 * the plugin that adds each, as `agents.tools()` does. */
export function sessionGroups(
  added: readonly (AddedTool & { pluginId?: string })[] = [],
): readonly ToolGroup[] {
  const plugins = new Map<string, Listed[]>();
  for (const tool of added) {
    const plugin = tool.pluginId ?? "plugin";
    plugins.set(plugin, [...(plugins.get(plugin) ?? []), listed(tool)]);
  }
  // Letters, digits and _ name a server or namespace in every harness; a
  // plugin whose name another group has gets a numbered one.
  const names = new Set(["buzz", "buzz_attention"]);
  const named = (plugin: string) => {
    const base = plugin.replace(/[^a-zA-Z0-9]/g, "_");
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}_${n}`;
    names.add(name);
    return name;
  };
  return [
    {
      name: "buzz",
      hint: "Read and act in Buzz as this agent.",
      load: "always",
      tools: TOOLS,
    },
    {
      name: "buzz_attention",
      hint: "Your attention: Interests (what you are responsible for), event watches that wake you when a matching event arrives, and timers that wake you on a schedule. Search for these tools when you need to set up, review or change them; interest_set and watch_add say how they work.",
      load: "search",
      tools: ATTENTION_TOOLS,
    },
    ...[...plugins].map(([plugin, tools]) => ({
      name: named(plugin),
      hint: `Tools the ${plugin} plugin adds: ${tools.map((tool) => tool.name).join(", ")}. Search for one when you need it.`,
      load: "search" as const,
      tools,
    })),
  ];
}

/** The tools a session lists, in one list: the Buzz tools, then those
 * plugins add. */
export const sessionTools = (
  added: readonly AddedTool[] = [],
): readonly Listed[] => [...BUZZ_SESSION.tools, ...added.map(listed)];

/** Changes when the added tools or their groups change, so a session that
 * keeps the list it started with can be replaced; empty while plugins add
 * none. A short hash, since Codex saves it with each binding. Sorted by name,
 * so the order plugins start in does not change it. */
export function addedKey(
  added: readonly (AddedTool & { pluginId?: string })[],
) {
  if (!added.length) return "";
  const text = JSON.stringify(
    added
      .map((tool) => [tool.pluginId ?? "", listed(tool)] as const)
      .sort(([, a], [, b]) => (a.name < b.name ? -1 : 1)),
  );
  // FNV-1a.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** Text for the end of a turn's prompt, as the agent's attention is now.
 * An agent with no Interests has nothing to review, so it need not load the
 * attention tools to find that out. */
export function turnNote(client?: Pick<BuzzClient, "attention">) {
  const attention = client?.attention;
  if (!attention) return undefined;
  if (!attention.enabled()) return ATTENTION_OFF;
  return attention.interests().length ? ATTENTION_REVIEW : ATTENTION_NONE;
}

/** Answers one tool call. Throws when the tool cannot run now; the message
 * is for the agent. Without a client, no tool can be called yet. `added`
 * are the tools plugins add now. */
export async function callSessionTool(
  client: BuzzClient | undefined,
  context: Context,
  name: string,
  args: Record<string, unknown>,
  added: readonly AddedTool[] = [],
): Promise<Reply> {
  if (!client) throw new Error("Buzz is not ready yet. Try again.");
  const tool = added.find((tool) => tool.name === name);
  if (tool) return tool.call(client, context, args);
  if (!isAttentionTool(name)) return callTool(client, context, name, args);
  const { attention } = client;
  if (!attention) throw new Error(`No tool ${name}`);
  // The owner can turn attention off while the session runs.
  if (!attention.enabled())
    throw new Error(
      `Attention is off for you: your owner turned it off, so these tools do nothing now.\n(classifier: ${attention.classifier()})`,
    );
  return callAttentionTool(attention, name, args);
}
