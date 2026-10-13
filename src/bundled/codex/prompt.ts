import { BUZZ_PROMPT } from "../../buzz-mcp/prompt";
import type { AgentHandle } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Config } from "./config";
import basePrompt from "./base_prompt.md?raw";

export type Conversation = { channelId: string; name: string; root?: string };
const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
export const rootOf = (event: EventData) =>
  threadReference(event)?.rootId ?? event.id;
export function developerInstructions(
  agent: AgentHandle,
  settings?: Config,
  team = "",
) {
  return `You are ${agent.name} (pubkey ${agent.pubkey}), a coding agent in Buzz.
The buzz namespace provides the shared Buzz tools, including messages, reactions, reads, uploads, canvas, and encrypted memory. Buzz access and signing are handled by the host. Do not invoke the buzz CLI or look for credentials. Use Codex's native coding tools in the workspace.

${basePrompt.trim()}

${BUZZ_PROMPT}

${settings ? `Current Buzz custom instructions replace all prior Buzz custom instructions. An empty section means no custom instructions apply.\n<agent-instructions>\n${settings.instructions}\n</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.${team ? `\n${team}` : ""}` : ""}`;
}

export function turnInput(
  event: EventData,
  conversation: Conversation,
  text: string,
  interest = "",
  steering = false,
) {
  const section = steering
    ? "new-message-arrived-while-you-were-working"
    : "buzz-event";
  return `<context>\n${quoted({ channel_id: conversation.channelId, channel_name: conversation.name, session_scope: conversation.root ? "thread" : "channel", session_thread: conversation.root, reply_to: rootOf(event) })}\n</context>\n<${section}>\n${quoted(event)}\nRequest: ${quoted(text)}\n</${section}>${interest ? `\n<interest>\n${quoted(interest)}\n</interest>` : ""}`;
}
export function sessionName(agent: AgentHandle, conversation: Conversation) {
  return `Buzz #${conversation.name.replace(/\s+/g, " ").slice(0, 100)}${conversation.root ? ` · thread ${conversation.root.slice(0, 8)}` : ""} · ${agent.name}`;
}
