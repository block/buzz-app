import {
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useState,
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
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { createCorpus } from "./corpus.ts";
import type { FinderItem, RegisteredSource } from "./service";

const LIMIT = 50;

type Listed =
  | Readonly<{
      query: string;
      items: readonly FinderItem[];
      /** Matched code points of each label, by item ID. */
      matches?: ReadonlyMap<string, readonly number[]>;
      /** How many matched, of which `items` are the best. */
      total?: number;
    }>
  | Readonly<{ query: string; error: true }>;

/** Every row, ranked by Finder's matcher over label and keywords. Ties keep
 * the source's order. */
function useRanked(source: RegisteredSource, query: string): Listed {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query reads the list again, so it stays current while typing.
  const items = useMemo(() => {
    if (!("items" in source)) return undefined;
    try {
      return source.items();
    } catch (error) {
      console.error(`Finder source ${source.key} failed`, error);
      return null;
    }
  }, [source, query]);
  const corpus = useMemo(() => {
    if (!items) return undefined;
    const ranked = createCorpus();
    ranked.add(
      items.map((item, n) => ({
        id: item.id,
        channelId: "",
        authorId: "",
        // Newer wins a tie; the first row is "newest".
        createdAt: items.length - n,
        author: item.keywords ?? "",
        place: "",
        text: item.label,
      })),
    );
    return ranked;
  }, [items]);
  if (items === null) return { query, error: true };
  if (!items || !corpus) return { query, items: [] };
  const byId = new Map(items.map((item) => [item.id, item]));
  const results = corpus.search(query, LIMIT);
  return {
    query,
    items: results.hits.flatMap(({ doc }) => byId.get(doc.id) ?? []),
    total: results.total,
    matches: new Map(
      results.hits.map(({ doc, positions }) => [doc.id, positions]),
    ),
  };
}

/** What the source published for the current text, as it arrives. */
function useSearched(
  source: RegisteredSource,
  query: string,
): Listed | undefined {
  const [listed, setListed] = useState<Listed>();
  useEffect(() => {
    if (!("search" in source)) return;
    const controller = new AbortController();
    try {
      source.search(
        query,
        (items) => {
          if (!controller.signal.aborted)
            setListed({ query, items: [...items] });
        },
        controller.signal,
      );
    } catch (error) {
      console.error(`Finder source ${source.key} failed`, error);
      setListed({ query, error: true });
    }
    return () => controller.abort();
  }, [source, query]);
  return listed?.query === query ? listed : undefined;
}

export function SourceResults({
  source,
  query,
  setQuery,
  input,
  open,
  session,
  onOpenChange,
  onClose,
  footer,
}: {
  source: RegisteredSource;
  query: string;
  setQuery: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  open: boolean;
  session: RelaySession | undefined;
  onOpenChange: (open: boolean) => void;
  /** Leaves this source for All of Buzz. */
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ranked = useRanked(source, query);
  const searched = useSearched(source, query);
  const listed = "items" in source ? ranked : searched;
  // biome-ignore lint/correctness/useExhaustiveDependencies: previews must not cross sessions.
  const previews = useMemo<PreviewCache>(() => new Map(), [session]);
  const items = listed && "items" in listed ? listed.items : [];
  const byKey = new Map(items.map((item) => [`item:${item.id}`, item]));
  const rows = items.map((item): SearchDestination => {
    const matches =
      "items" in ranked ? ranked.matches?.get(item.id) : undefined;
    const preview = item.preview;
    return {
      key: `item:${item.id}`,
      label: item.label,
      ...(matches?.length ? { matches } : {}),
      ...(item.detail ? { detail: item.detail } : {}),
      icon: item.icon ?? ChatCircleIcon,
      ...(item.avatar && {
        avatar: {
          shape: item.avatar.shape ?? "circle",
          ...(item.avatar.src && { src: item.avatar.src }),
          name: item.avatar.name ?? item.label,
        },
      }),
      ...(preview &&
        typeof preview === "object" && {
          peek:
            preview.kind === "channel"
              ? { kind: "channel" as const, channelId: preview.channelId }
              : { kind: "person" as const, pubkey: preview.pubkey },
        }),
      run: () => {
        onOpenChange(false);
        try {
          item.run();
        } catch (error) {
          console.error(`Finder source ${source.key} failed`, error);
        }
      },
    };
  });
  const custom = items.some((item) => typeof item.preview === "function");
  return (
    <SearchChoices
      label={source.title}
      query={query}
      onQueryChange={setQuery}
      input={input}
      open={open}
      highlightEmpty
      groups={[
        {
          label: source.title,
          hideLabel: true,
          destinations: rows,
          total: rows.length,
          count:
            listed && "items" in listed && (listed.total ?? 0) > rows.length
              ? `${rows.length} of ${listed.total?.toLocaleString()}`
              : undefined,
          empty:
            listed && "error" in listed
              ? "This list couldn't load."
              : listed
                ? "Nothing matches. Try fewer letters."
                : "",
        },
      ]}
      footer={footer}
      scope={{ id: source.key, label: source.title, onRemove: onClose }}
      peek={{
        ranked: false,
        busy: !listed,
        preview:
          session || custom
            ? (row, tone, follow) => {
                const item = row ? byKey.get(row.key) : undefined;
                const Preview =
                  typeof item?.preview === "function"
                    ? item.preview
                    : undefined;
                if (Preview) return <Preview />;
                return session ? (
                  <SearchPreview
                    session={session}
                    cache={previews}
                    row={row?.peek ? row : undefined}
                    tone={tone}
                    follow={follow}
                    terms={[]}
                    nameOf={(pubkey) =>
                      session.profiles.snapshot().get(pubkey)?.name ??
                      pubkey.slice(0, 10)
                    }
                    whereOf={(channelId) =>
                      session.channels.get?.(channelId)?.name ?? "Conversation"
                    }
                  />
                ) : null;
              }
            : undefined,
      }}
    />
  );
}
