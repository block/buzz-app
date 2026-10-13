// The Buzz tools as an MCP server inside the host process: answers one
// JSON-RPC message at a time, as Claude sends them over its stream-json
// pipe to an in-process (`sdk`) server. Holds no state between messages.
import type {
  AgentAttention,
  AgentToolCaller,
  RegisteredAgentTool,
} from "../features/agents/service";
import {
  ATTENTION_TOOLS,
  callAttentionTool,
  isAttentionTool,
} from "./attention";
import type { BuzzClient, Context } from "./client";
import { callPluginTool, listed, pluginTools } from "./plugin-tools";
import { callTool, type Reply, TOOLS } from "./tools";

type Message = Readonly<{
  id?: string | number | null;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}>;

/** The attention tool set for one session. `offered` decides the tool list,
 * which a session reads once, so it is fixed when the session starts; `api` is
 * the agent's attention once a delivery has given the session a handle. */
export type AttentionTools = Readonly<{
  offered: boolean;
  api?: AgentAttention;
}>;

/** Plugins' tools for one session: the active ones when asked, and who calls
 * them once a delivery has given the session a handle. */
export type PluginTools = Readonly<{
  tools(): readonly RegisteredAgentTool[];
  caller?: AgentToolCaller;
}>;

/** Answers `input`. Without a client, tools are listed but cannot be called.
 * Attention tools are listed only when `attention` offers them; plugins' tools
 * when `plugins` is given. */
export async function respond(
  client: BuzzClient | undefined,
  context: Context,
  input: unknown,
  attention?: AttentionTools,
  plugins?: PluginTools,
) {
  const { id, method, params = {} } = (input ?? {}) as Message;
  // A notification needs no answer, but the pipe expects one.
  if (id === undefined || id === null)
    return { jsonrpc: "2.0", id: 0, result: {} };
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz", version: "1" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({
        tools: [
          ...TOOLS,
          ...(attention?.offered ? ATTENTION_TOOLS : []),
          ...(plugins ? pluginTools(plugins.tools()).map(listed) : []),
        ],
      });
    case "tools/call":
      try {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        let reply: Reply;
        if (attention?.offered && isAttentionTool(name)) {
          const api = attention.api;
          if (!api) throw new Error("Buzz is not ready yet. Try again.");
          // The owner can turn attention off while this session runs.
          if (!api.enabled())
            throw new Error(
              `Attention is off for you: your owner turned it off, so these tools do nothing now.\n(classifier: ${api.classifier()})`,
            );
          reply = await callAttentionTool(api, name, args);
        } else if (
          plugins &&
          !isAttentionTool(name) &&
          !TOOLS.some((tool) => tool.name === name)
        ) {
          if (!plugins.caller)
            throw new Error("Buzz is not ready yet. Try again.");
          const answer = callPluginTool(
            plugins.tools(),
            name,
            args,
            plugins.caller,
          );
          if (!answer)
            throw new Error(
              `No tool ${name}. Its plugin may have been turned off.`,
            );
          reply = await answer;
        } else {
          if (!client) throw new Error("Buzz is not ready yet. Try again.");
          reply = await callTool(client, context, name, args);
        }
        return result({ content: content(reply) });
      } catch (error) {
        return result({
          content: [{ type: "text", text: errorText(error) }],
          isError: true,
        });
      }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `No method ${String(method)}` },
      };
  }
}

/** A tool's answer as MCP content. */
export const content = (reply: Reply) =>
  typeof reply === "string"
    ? [{ type: "text" as const, text: reply }]
    : [{ type: "image" as const, data: reply.data, mimeType: reply.type }];

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
