// A turn's history as its conversation shows it now.
import type { AgentReads } from "../agents/reads";
import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "../relay/events";
import type { EventData, ReadFilter } from "../relay/events";
import { foldMessages, messageAuthor } from "../relay/fold";
import { readAuthorNames } from "./author-names";

/** These chat messages of one channel with the edits and deletions the
 * timeline applies, as Codex history does: a deleted message is left out and
 * an edited one reads as its current edit, so history never revives replaced
 * text. */
export async function currentMessages(
  channelId: string,
  messages: readonly EventData[],
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
  profiles?: Pick<AgentReads, "profiles" | "profile" | "authorNames">,
  signingAuthority?: string,
): Promise<readonly EventData[]> {
  const changes = messages.length
    ? await read([
        {
          kinds: [40003, 5, 9005],
          "#h": [channelId],
          "#e": messages.map((message) => message.id),
          limit: 500,
        },
      ])
    : [];
  if (!changes.length) return messages;
  // An agent's attested owner may edit its messages, as the timeline shows.
  const authors = [
    ...new Set(messages.map((item) => messageAuthor(item, signingAuthority))),
  ];
  await readAuthorNames(profiles, messages, signingAuthority);
  const owners = new Map<string, string>();
  await Promise.all(
    authors.map(async (author) => {
      const profile = profiles?.profile(author);
      const owner =
        profile && hasEventProof(profile) && (await attestedOwner(profile));
      if (owner) owners.set(author, owner);
    }),
  );
  const rows = new Map(
    foldMessages(channelId, "", [...messages, ...changes], {
      includeReplies: true,
      signingAuthority,
      agentOwner: (author) => owners.get(author),
    }).map((row) => [row.id, row]),
  );
  return messages.flatMap((message) => {
    const row = rows.get(message.id);
    if (!row) return [];
    return row.edited
      ? [{ ...message, content: row.sourceContent ?? row.content }]
      : [message];
  });
}
