import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import { parseAttachments } from "../relay/fold";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { profileMentionParts } from "../messages/profile-mentions";
import { profileKey } from "../profiles/target";
import type { DraftRecipient } from "../messages/mention-draft";
import { ownSolo, SOLO_NAMED_LABEL } from "../solo/labels";
import { isStartingChatTitle } from "../solo/chat-title";

/**
 * Names the owner's Solo chat with an agent harness's own title, once. Only a
 * chat that still has the name it was created with is renamed: the name in the
 * create event its owner signed, whichever app and title rule wrote it. When
 * the relay has no such event for it, only a name its first message derives is
 * replaced.
 * The first tagged harness on that message names it, regardless of retry
 * wording. A chat renamed by anyone, including by this, is never touched
 * again. The owner's session renames it, as the owner would.
 */
export async function nameSoloChat(
  relay: RelayData | undefined,
  owner: string,
  agent: string,
  event: RelayEvent,
  title: string,
) {
  // Every reason to leave a chat's name is quiet by design; log which one, or
  // a title that never lands can't be traced.
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  const skip = (reason: string) =>
    console.info(`Solo chat not named (${reason})`, { channel, title });
  const snapshot = relay?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner)
    return skip("owner not connected");
  const { session } = snapshot;
  const listed = () =>
    session.channels.list().channels.find((item) => item.id === channel);
  const solo = () => ownSolo(listed(), owner);
  if (!channel || !solo()) return skip("not the owner's Solo chat");
  const name = [...canonicalDetailsName(title.replace(/\s+/g, " "))]
    .slice(0, 120)
    .join("");
  const details = session.channelDetails;
  if (!name) return skip("empty title");
  if (!details.available) return skip("channel editing unavailable");
  // A chat the list already shows as named costs no relay read. The details
  // loaded below decide for one the list has not caught up on.
  const summary = listed();
  if (summary?.labels?.includes(SOLO_NAMED_LABEL) || summary?.name === name)
    return skip("chat already renamed");
  const current = () => {
    const latest = relay?.snapshot();
    return (
      latest?.status === "ready" &&
      latest.viewer === owner &&
      latest.session === session &&
      solo()
    );
  };
  // Naming is for a new chat, not an unbounded history scan. A full page cannot
  // establish the first message, so keep the existing title rather than guess.
  // An ordinary filter, not a channel window: the relay's window ignores authors
  // and rejects `until` without a `before_id` cursor. Replies are dropped below.
  const limit = 100;
  const history = await session.read([
    {
      kinds: [9],
      authors: [owner],
      "#h": [channel],
      until: event.created_at,
      limit,
      consistency: "strong",
    },
  ]);
  if (!current()) return skip("connection changed");
  if (history.length >= limit) return skip("too much history");
  // session.read also merges the local outbox; an unsent event cannot be
  // evidence of the chat's original published message.
  if (
    history.some(
      (message) =>
        message.delivery !== undefined &&
        message.delivery !== "accepted" &&
        message.delivery !== "seen",
    )
  )
    return skip("unsent message");
  const messages = history
    .filter(
      (message) =>
        message.kind === 9 &&
        message.pubkey === owner &&
        message.created_at <= event.created_at &&
        !threadReference(message) &&
        message.tags.some(([key, value]) => key === "h" && value === channel),
    )
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const original = messages[0];
  if (!original) return skip("first message not found");
  // Same-second messages do not prove authoring order. Do not choose a winner.
  if (messages[1]?.created_at === original.created_at)
    return skip("first message unclear");
  if (original.tags.find(([tag]) => tag === "p")?.[1] !== agent)
    return skip("another agent was tagged first");
  const recipients: DraftRecipient[] = [];
  let offset = 0;
  for (const part of profileMentionParts(
    {
      content: original.content,
      mentions: original.tags
        .filter(([key]) => key === "p")
        .map((tag) => tag[1] ?? ""),
    },
    session.profiles.snapshot(),
    session.agentChoices.snapshot().identities,
  )) {
    const pubkey = part.target && profileKey(part.target);
    if (pubkey)
      recipients.push({
        pubkey,
        name: part.text.slice(1),
        start: offset,
        end: offset + part.text.length,
      });
    offset += part.text.length;
  }
  // The name the chat was created with, from its own create event. The relay
  // accepts one per chat and a rename leaves it as signed. Its signer is the
  // chat's creator, who is the owner here, so only the owner's event for this
  // chat alone is evidence; any other answer is ignored. A read that fails
  // throws and names nothing; only a completed read that finds no create
  // event, which its creator may have deleted, leaves the name to be judged
  // against the first message.
  const created = await session.read([
    {
      kinds: [9007],
      authors: [owner],
      "#h": [channel],
      limit: 2,
      consistency: "strong",
    },
  ]);
  if (!current()) return skip("connection changed");
  const createdNames = new Set(
    created.flatMap((event) => {
      const chats = event.tags.filter(([key]) => key === "h");
      const stored =
        event.kind === 9007 &&
        event.pubkey === owner &&
        chats.length === 1 &&
        chats[0]?.length === 2 &&
        chats[0][1] === channel &&
        // The relay stores the signed name without these edges.
        canonicalDetailsName(
          event.tags.find(([key]) => key === "name")?.[1] ?? "",
        );
      return stored ? [stored] : [];
    }),
  );
  // Create events that disagree prove no single name. Do not choose a winner.
  if (createdNames.size > 1) return skip("created name unclear");
  const [createdName] = createdNames;
  const base = await details.load(channel);
  if (!current()) return skip("connection changed");
  if (!base.canEdit) return skip("owner can't edit the chat");
  if (
    base.labels?.includes(SOLO_NAMED_LABEL) ||
    base.name === name ||
    !(createdName !== undefined
      ? canonicalDetailsName(base.name) === createdName
      : // No create event: only a name the first message derives is replaced.
        isStartingChatTitle(
          base.name,
          { text: original.content, recipients },
          // What the message attached, so a title that names it is recognized.
          parseAttachments(original, []),
        ))
  )
    return skip("chat already renamed");
  await details.save(base, { ...base, name });
}
