// Event shapes follow the app's own writer, src/features/relay/messages.ts.
type Tagged = Readonly<{ id: string; tags: readonly (readonly string[])[] }>;
const HEX = /^[0-9a-f]{64}$/;

export const channelOf = (event: Tagged) =>
  event.tags.find((tag) => tag[0] === "h")?.[1];

/** The thread a message belongs to: its marked root, else the message it replies
 * to, else the message itself, which a reply then turns into a thread. */
export function threadRoot(event: Tagged): string {
  const marked = (marker: string) =>
    event.tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
  return marked("root") ?? marked("reply") ?? event.id;
}

/** A channel message: top-level without `rootId`, else a flat reply in that thread.
 * Each mention notifies its recipient. */
export function messageTags(
  channelId: string,
  rootId?: string,
  mentions: readonly string[] = [],
): string[][] {
  const invalid = [rootId, ...mentions].find(
    (id) => id !== undefined && !HEX.test(id),
  );
  if (invalid !== undefined)
    throw new Error(`Not a 64-character hex id: ${invalid}`);
  return [
    ["h", channelId],
    ...(rootId ? [["e", rootId, "", "reply"]] : []),
    ...[...new Set(mentions)].map((key) => ["p", key]),
  ];
}

type Stored = Tagged &
  Readonly<{
    pubkey: string;
    kind: number;
    created_at: number;
    content: string;
  }>;
export type Message = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  /** The thread this message is a reply in; absent on a top-level message. */
  thread?: string;
}>;

/** Messages as a reader sees them, oldest first: each with its author's latest edit
 * (40003) applied, and without those their author deleted (5). A read returns the
 * originals, so an edited message would otherwise show its first version. Deletions by a moderator (9005) are not applied. */
export function fold(events: readonly Stored[]): Message[] {
  const messages = new Map<string, Stored>();
  for (const event of events)
    if (event.kind === 9) messages.set(event.id, event);
  const edits = new Map<string, Stored>();
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== 40003 && event.kind !== 5) continue;
    for (const tag of event.tags) {
      const target = tag[0] === "e" ? messages.get(tag[1] ?? "") : undefined;
      if (!target || target.pubkey !== event.pubkey) continue;
      if (event.kind === 5) deleted.add(target.id);
      else if ((edits.get(target.id)?.created_at ?? -1) < event.created_at)
        edits.set(target.id, event);
    }
  }
  return [...messages.values()]
    .filter((message) => !deleted.has(message.id))
    .sort((a, b) => a.created_at - b.created_at)
    .map((message) => {
      const thread = threadRoot(message);
      return {
        id: message.id,
        pubkey: message.pubkey,
        created_at: message.created_at,
        content: edits.get(message.id)?.content ?? message.content,
        ...(thread === message.id ? {} : { thread }),
      };
    });
}
