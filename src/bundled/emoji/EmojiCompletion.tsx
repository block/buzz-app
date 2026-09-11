import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import { CustomEmoji } from "./CustomEmoji";
import {
  searchEmoji,
  searchCustomEmoji,
  type EmojiMatch,
} from "./emoji-search";

export function EmojiCompletion({
  session,
  query,
  publish,
}: ComposerCompletionProps) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const [attempt, retry] = useState(0);
  useEffect(() => {
    void session.emoji.ensure();
  }, [session]);
  useEffect(() => {
    void attempt; // Explicit retry repeats this query even when catalog data is unchanged.
    let live = true;
    let withdraw: (() => void) | false = false;
    const custom = catalog.entries.filter((item) => !!session.media(item.url));
    const items = (matches: readonly EmojiMatch[]) =>
      matches.map((item) => ({
        id: item.id,
        label: `:${item.shortcode}:`,
        detail: item.url ? "Community emoji" : item.name,
        preview: item.url ? (
          <CustomEmoji
            emoji={{ shortcode: item.shortcode, url: item.url }}
            media={session.media}
          />
        ) : (
          item.text
        ),
        edit: { text: item.text },
      }));
    const retrySearch = () => {
      retry((value) => value + 1);
      if (catalog.status === "error") void session.emoji.refresh();
    };
    withdraw = publish({
      items: items(searchCustomEmoji(query.query, custom)),
      status: "Searching emoji…",
    });
    void searchEmoji(query.query, custom)
      .then((matches) => {
        if (!live) return;
        if (withdraw) withdraw();
        withdraw = publish({
          items: items(matches),
          ...(catalog.status === "error"
            ? {
                status: "Community emoji unavailable; Unicode results shown.",
                retry: retrySearch,
              }
            : {}),
        });
      })
      .catch(() => {
        if (!live) return;
        if (withdraw) withdraw();
        withdraw = publish({
          items: items(searchCustomEmoji(query.query, custom)),
          status: "Unicode emoji unavailable. Custom matches shown.",
          retry: retrySearch,
        });
      });
    const unsubscribe = session.emoji.subscribe(() => {
      live = false; // Late search completion cannot revive the previous catalog.
      if (withdraw) withdraw();
    });
    return () => {
      live = false;
      unsubscribe();
      if (withdraw) withdraw();
    };
  }, [session, query.query, publish, catalog, attempt]);
  return null;
}
