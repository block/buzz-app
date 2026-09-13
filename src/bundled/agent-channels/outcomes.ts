import type {
  ExternalObjectReference,
  Objects,
} from "../../features/objects/service";
import type { VisibleEvent } from "../../features/relay/projection";
import type { AgentNode, ChannelNode } from "./relationships";
import { isObservedActivityEvent } from "./relationships";

export type OutcomeEvidence = Readonly<{
  agentId: string;
  channelId: string;
  messageEventId: string;
  sharedAt: number;
}>;
export type AgentOutcomeReference = Readonly<{
  key: string;
  reference: ExternalObjectReference;
  evidence: readonly OutcomeEvidence[];
}>;

const URL = /https:\/\/[^\s<>"']+/g;

export function extractAgentOutcomes(
  activity: readonly VisibleEvent[],
  agents: readonly AgentNode[],
  channels: readonly ChannelNode[],
  objects: Pick<Objects, "resolve">,
): readonly AgentOutcomeReference[] {
  const agentByPubkey = new Map(
    agents.flatMap((agent) =>
      agent.identityPubkeys.map((pubkey) => [pubkey, agent.id] as const),
    ),
  );
  const channelIds = new Set(channels.map((channel) => channel.id));
  const outcomes = new Map<
    string,
    { reference: ExternalObjectReference; evidence: OutcomeEvidence[] }
  >();
  for (const event of activity) {
    if (event.kind !== 9 || !isObservedActivityEvent(event)) continue;
    const agentId = agentByPubkey.get(event.pubkey);
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!agentId || !channelId || !channelIds.has(channelId)) continue;
    for (const candidate of event.content.match(URL) ?? []) {
      const target = trimUrl(candidate);
      const resolved = objects.resolve(target);
      if (resolved?.reference.kind !== "pull") continue;
      const key = `${resolved.provider.key}:${resolved.reference.key}`;
      const evidence = Object.freeze({
        agentId,
        channelId,
        messageEventId: event.id,
        sharedAt: event.created_at,
      });
      const existing = outcomes.get(key);
      if (existing) {
        if (
          !existing.evidence.some(
            (item) => item.messageEventId === evidence.messageEventId,
          )
        )
          existing.evidence.push(evidence);
      } else
        outcomes.set(key, {
          reference: resolved.reference,
          evidence: [evidence],
        });
    }
  }
  return Object.freeze(
    [...outcomes.entries()]
      .map(([key, outcome]) =>
        Object.freeze({
          key,
          reference: outcome.reference,
          evidence: Object.freeze(
            outcome.evidence.sort(
              (a, b) =>
                b.sharedAt - a.sharedAt ||
                a.messageEventId.localeCompare(b.messageEventId),
            ),
          ),
        }),
      )
      .sort(
        (a, b) =>
          (b.evidence[0]?.sharedAt ?? 0) - (a.evidence[0]?.sharedAt ?? 0) ||
          a.key.localeCompare(b.key),
      ),
  );
}

function trimUrl(value: string) {
  return value.replace(/[),.;:!?\]}]+$/g, "");
}
