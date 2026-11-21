import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  SearchChoices,
  type SearchDestination,
} from "../../app/shell/SearchChoices";
import {
  type PreviewCache,
  SearchPreview,
} from "../../app/shell/SearchPreview";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { avatarMedia } from "../../shared/avatar-source";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { FinderCorpus, FinderDoc } from "./corpus.ts";

/** About `width` characters of `text` around its first match, with the
 * matched code points shifted into the window. */
export function excerpt(
  text: string,
  positions: readonly number[],
  width = 160,
) {
  const chars = [...text];
  const first = positions[0] ?? 0;
  let start = Math.max(0, first - Math.floor(width / 4));
  // Start at a word when one begins nearby.
  const space = chars.lastIndexOf(" ", start);
  if (start > 0 && space >= 0 && first - space < width / 2) start = space + 1;
  const end = Math.min(chars.length, start + width);
  const lead = start > 0 ? "…" : "";
  return {
    text: `${lead}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`,
    matches: positions
      .filter((p) => p >= start && p < end)
      .map((p) => p - start + lead.length),
  };
}

const emptyProfiles: ReturnType<RelaySession["profiles"]["snapshot"]> =
  new Map();
const noProfiles = () => emptyProfiles;
const noSubscribe = () => () => {};

/** Search your own conversations, Telescope-style: the field, the best
 * matches, and a preview of the highlighted one in context. */
export function FinderDialog({
  open,
  onOpenChange,
  corpus,
  revision,
  session,
  status,
  openMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  corpus: FinderCorpus;
  /** Changes whenever the corpus does, so results refresh. */
  revision: number;
  session: RelaySession | undefined;
  /** Shown under the results, such as how far indexing has got. */
  status?: ReactNode;
  openMessage: (doc: FinderDoc) => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLElement>(null);
  const previews = useRef<PreviewCache>(new Map()).current;
  const profiles = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    session?.profiles.snapshot ?? noProfiles,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` names the corpus contents.
  const results = useMemo(
    () => corpus.search(query),
    [corpus, query, revision],
  );
  const byId = new Map(results.hits.map((hit) => [hit.doc.id, hit.doc]));
  const rows: SearchDestination[] = results.hits.map(({ doc, positions }) => {
    const shown = excerpt(doc.text, positions);
    return {
      key: doc.id,
      label: shown.text || "Attachment",
      ...(shown.matches.length ? { matches: shown.matches } : {}),
      detail: `${doc.place} · ${doc.author} · ${formatItemTimestamp(doc.createdAt)}`,
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(profiles.get(doc.authorId)?.picture, session?.media),
        shape: "circle" as const,
        name: doc.author,
      },
      peek: {
        kind: "message" as const,
        channelId: doc.channelId,
        messageId: doc.id,
        createdAt: doc.createdAt,
        authorId: doc.authorId,
        text: doc.text,
        mentioned: { content: doc.text, mentions: [] },
      },
      run: () => {
        onOpenChange(false);
        openMessage(doc);
      },
    };
  });
  // The preview highlights whole words; fuzzy letters show in the row.
  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word && !word.startsWith("!"))
        .map((word) => word.replace(/^'/, "")),
    [query],
  );
  const total = results.total;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find in your conversations"
      footerGap="none"
      motion="default"
      dismissOnOutsideClick
      presentation="search"
      size="wide"
      height="stable-tall"
      bodyLayout="flex"
      initialFocus={input}
    >
      <SearchChoices
        label="Find in your conversations"
        query={query}
        onQueryChange={setQuery}
        input={input}
        open={open}
        highlightEmpty
        groups={[
          {
            label: query.trim() ? "Matches" : "Recent",
            destinations: rows,
            total: rows.length,
            count:
              total > rows.length
                ? `${rows.length} of ${total.toLocaleString()}`
                : undefined,
            empty: corpus.size
              ? "Nothing matches. Try fewer letters, or drop a word."
              : "No messages indexed yet.",
          },
        ]}
        footer={status}
        peek={{
          ranked: false,
          preview: session
            ? (row, tone, follow) => (
                <SearchPreview
                  session={session}
                  cache={previews}
                  row={row && byId.has(row.key) ? row : undefined}
                  tone={tone}
                  follow={follow}
                  terms={terms}
                  nameOf={(pubkey) =>
                    profiles.get(pubkey)?.name ??
                    results.hits.find((hit) => hit.doc.authorId === pubkey)?.doc
                      .author ??
                    pubkey.slice(0, 10)
                  }
                  whereOf={(channelId) =>
                    results.hits.find((hit) => hit.doc.channelId === channelId)
                      ?.doc.place ?? "Conversation"
                  }
                />
              )
            : undefined,
        }}
      />
    </Dialog>
  );
}
