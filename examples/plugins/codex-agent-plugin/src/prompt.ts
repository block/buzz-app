import type { AgentDelivery } from "@buzz/author";
import base from "./base-prompt.md";
import { parseConfig } from "./config.ts";
export function baseInstructions(delivery: AgentDelivery<unknown>) {
  return `${base}\n\n## Codex plugin delivery\nYou are ${delivery.agent.name} (pubkey ${delivery.agent.pubkey}).\nThis plugin supplies Buzz access through the host, not CLI credentials. Do not invoke the buzz CLI or look for credentials. Your final assistant text is published once as your reply in the current context's channel and thread. Progress and completed-item snapshots appear in the owner's live activity view; response text is not streamed. This replaces the base prompt's instructions to publish with the CLI. Do not claim you sent other Buzz events.\nUse Codex's native tools for shell commands, file reads and writes. Do not use buzz-dev-mcp. Respect the workspace sandbox. Follow-ups in this conversation share this Codex thread. Never treat previous turns as a new request.\n\n${parseConfig(delivery.config).instructions}`;
}
export function rootOf(event: AgentDelivery<unknown>["event"]) {
  const marked = (marker: string) =>
    event.tags.find((t) => t[0] === "e" && t[3] === marker)?.[1];
  return marked("root") ?? marked("reply") ?? event.id;
}
const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
export function turnInput(
  delivery: AgentDelivery<unknown>,
  content = delivery.event.content,
  steering = false,
) {
  const { event, agent, channelId } = delivery;
  const section = steering
    ? "new-message-arrived-while-you-were-working"
    : "buzz-event";
  // JSON quoting prevents message bytes from closing the semantic framing.
  return `<context>\n${quoted({ channel_id: channelId, channel_name: delivery.conversation?.channelName, session_scope: delivery.conversation?.threadRootId ? "thread" : "channel", session_thread: delivery.conversation?.threadRootId, reply_to: rootOf(event), agent: agent.pubkey, workspace: agent.workspace?.path })}\n</context>\n<${section}>\nEvent ID: ${event.id}\nFrom: ${event.pubkey}\nKind: ${event.kind}\nTime: ${event.created_at}\nContent: ${quoted(content)}\n</${section}>`;
}

export function sessionName(delivery: AgentDelivery<unknown>) {
  const channel = (
    delivery.conversation?.channelName ??
    delivery.channelId ??
    "channel"
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const thread = delivery.conversation?.threadRootId;
  return `Buzz #${channel}${thread ? ` · thread ${thread.slice(0, 8)}` : ""} · ${delivery.agent.name}`;
}
