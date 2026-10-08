import type { AgentHandle } from "../../features/agents2/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Config } from "./config";
import base from "./base-prompt.md?raw";

export type Conversation = { channelId: string; name: string; root?: string };
const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
export const rootOf = (event: EventData) =>
  threadReference(event)?.rootId ?? event.id;
export function baseInstructions(agent: AgentHandle, settings: Config) {
  return `${base}\n\n## Codex plugin delivery\nYou are ${agent.name} (pubkey ${agent.pubkey}).\nBuzz access is supplied by the host, not CLI credentials. Do not invoke the buzz CLI or look for credentials. Your final assistant text is published once as your reply to the current event's thread. This replaces the base prompt's CLI publishing instructions. Do not claim you sent other Buzz events.\nUse Codex's native shell and file tools. Respect the workspace sandbox. Do not use buzz-dev-mcp. Follow-ups share this Codex thread; previous context is not a new request.\n\n${settings.instructions}`;
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
  return `<context>\n${quoted({ channel_id: conversation.channelId, channel_name: conversation.name, session_scope: conversation.root ? "thread" : "channel", session_thread: conversation.root, reply_to: event.id })}\n</context>\n<${section}>\n${quoted(event)}\nRequest: ${quoted(text)}\n</${section}>${interest ? `\n<interest>\n${quoted(interest)}\n</interest>` : ""}`;
}
export function sessionName(agent: AgentHandle, conversation: Conversation) {
  return `Buzz #${conversation.name.replace(/\s+/g, " ").slice(0, 100)}${conversation.root ? ` · thread ${conversation.root.slice(0, 8)}` : ""} · ${agent.name}`;
}
