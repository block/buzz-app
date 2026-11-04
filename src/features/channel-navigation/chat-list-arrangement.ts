import type { ChatList, ChatListEntry } from "../conversation/service";

export type ArrangedChats<T extends ChatListEntry> = Readonly<{
  chats: readonly T[];
  folded?: Readonly<{ label: string; ids: ReadonlySet<string> }>;
}>;

const MAX_LABEL = 40;

/** A plugin arrangement can reorder and fold, never drop or invent a chat. */
export function arrangeChatList<T extends ChatListEntry>(
  arrange: ChatList["arrange"],
  chats: readonly T[],
): ArrangedChats<T> {
  if (!arrange) return { chats };
  let layout: ReturnType<NonNullable<ChatList["arrange"]>>;
  try {
    layout = arrange(chats.map((chat) => Object.freeze({ ...chat })));
  } catch {
    return { chats };
  }
  if (!layout || typeof layout !== "object") return { chats };
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const ordered: T[] = [];
  const placed = new Set<string>();
  if (Array.isArray(layout.order))
    for (const id of layout.order) {
      const chat = typeof id === "string" ? byId.get(id) : undefined;
      if (!chat || placed.has(id)) continue;
      placed.add(id);
      ordered.push(chat);
    }
  for (const chat of chats) if (!placed.has(chat.id)) ordered.push(chat);
  const folded = layout.folded;
  const label =
    folded && typeof folded.label === "string" ? folded.label.trim() : "";
  if (!label || label.length > MAX_LABEL || !Array.isArray(folded?.ids))
    return { chats: ordered };
  const ids = new Set(
    folded.ids.filter(
      (id): id is string =>
        typeof id === "string" && byId.has(id) && !byId.get(id)?.pinned,
    ),
  );
  return ids.size
    ? { chats: ordered, folded: { label, ids } }
    : { chats: ordered };
}
