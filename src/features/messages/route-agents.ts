import type { ConversationExtensions } from "../conversation/contracts";
import type { ComposerSession } from "./composer-session";
import { splitPartition } from "../relay/partition";

/** Routes only explicitly selected, known agents; people and ordinary channels
 * keep their normal mention behavior. No membership or signing authority moves. */
export async function assignAgents(
  extensions: ConversationExtensions | undefined,
  session: ComposerSession,
  channelId: string,
  text: string,
  recipients: readonly string[],
  signal: AbortSignal,
) {
  if (!extensions?.routeAgents || recipients.length < 2) return undefined;
  const choices = session.agentChoices.snapshot();
  const names = new Map(
    choices.identities.map((agent) => [agent.pubkey, agent.name]),
  );
  if (recipients.some((key) => !names.has(key))) return undefined;
  const profiles = session.profiles.snapshot();
  return extensions.routeAgents(
    {
      text,
      channelId,
      community:
        typeof session.scope === "string"
          ? splitPartition(session.scope)?.communityOrigin
          : undefined,
      candidates: [...new Set(recipients)].map((pubkey) => ({
        pubkey,
        name: names.get(pubkey) ?? pubkey,
        description: profiles.get(pubkey)?.about?.slice(0, 1_000) ?? "",
      })),
      context: (session.channels.window?.(channelId)?.rows ?? [])
        .slice(-6)
        .map((row) => ({
          author: row.authorId,
          text: row.content.slice(0, 2_000),
        })),
    },
    signal,
  );
}
