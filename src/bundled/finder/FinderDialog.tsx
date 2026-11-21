import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  SearchChoices,
  type SearchDestination,
  type SearchGroup,
} from "../../app/shell/SearchChoices";
import {
  type PreviewCache,
  SearchPreview,
} from "../../app/shell/SearchPreview";
import { useSearchMessages } from "../../app/shell/useSearchMessages";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { avatarMedia } from "../../shared/avatar-source";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { messageSearchable } from "../../shared/search-debounce";
import {
  createCorpus,
  type FinderCorpus,
  type FinderDoc,
  type FinderResults,
} from "./corpus.ts";
import type { ChannelSearchStatus, FinderSync } from "./sync";

export type FinderScope = "channel" | "buzz" | undefined;

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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  corpus: FinderCorpus;
  revision: number;
  session: RelaySession | undefined;
  sync?: FinderSync | undefined;
  currentChannelId?: string | undefined;
  scope: FinderScope;
  onScopeChange: (scope: FinderScope) => void;
  status?: ReactNode;
  openMessage: (doc: FinderDoc) => void;
};

export function FinderDialog(props: Props) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one budget per dialog opening and session, even when switching scopes.
  const opening = useMemo(() => ({}), [props.open, props.session]);
  const contents = { ...props, query, setQuery, input, opening };
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
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
      {props.open &&
        (props.scope === "buzz" && props.session ? (
          <BuzzResults {...contents} session={props.session} />
        ) : (
          <LocalResults {...contents} />
        ))}
    </Dialog>
  );
}

type Contents = Props & {
  query: string;
  setQuery: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  opening: object;
};

function LocalResults(props: Contents) {
  const { corpus, query, revision, sync, scope, currentChannelId, opening } =
    props;
  const channelId = scope === "channel" ? currentChannelId : undefined;
  const typed = useRef(query);
  typed.current = query;
  const reader = useRef<ReturnType<FinderSync["searchChannel"]>>(undefined);
  const [progress, setProgress] = useState<ChannelSearchStatus>();
  useEffect(() => {
    setProgress(undefined);
    if (!sync || !channelId) return;
    const running = sync.searchChannel(
      channelId,
      () => corpus.search(typed.current, 20, channelId).total < 20,
      setProgress,
      opening,
    );
    reader.current = running;
    return () => {
      reader.current = undefined;
      running.dispose();
    };
  }, [sync, channelId, corpus, opening]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: edits and new corpus contents wake the existing reader.
  useEffect(() => {
    reader.current?.wake();
  }, [query, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision names the corpus contents.
  const results = useMemo(
    () => corpus.search(query, 50, channelId),
    [corpus, query, revision, channelId],
  );
  const channel = props.session?.channels.get?.(channelId ?? "");
  const where = channel?.name
    ? channel.channelType === "stream" || channel.channelType === "forum"
      ? `#${channel.name}`
      : channel.name
    : "this conversation";
  const footer = channelId ? (
    <LoadingRegion
      pending={!!progress?.loading}
      label="Searching older messages…"
      feedback={
        progress?.error && progress.loading ? (
          <p role="alert">Older messages could not load. Retrying…</p>
        ) : undefined
      }
    >
      <div
        className="flex flex-wrap items-center gap-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {progress && !progress.available
          ? "Join this conversation to search its history."
          : progress?.complete
            ? `Searched all of ${where}`
            : progress?.oldest
              ? `Searched back to ${new Date(progress.oldest * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
              : "Older messages are read when fewer than 20 match."}
        {progress?.capped && !progress.complete && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              props.input.current?.focus();
              reader.current?.keepGoing();
            }}
          >
            Keep going
          </Button>
        )}
      </div>
    </LoadingRegion>
  ) : (
    props.status
  );
  return (
    <Choices
      {...props}
      results={results}
      footer={footer}
      busy={!!progress?.loading}
      empty={
        channelId
          ? progress?.complete
            ? "No messages in this channel match. Try fewer letters, or drop a word."
            : "No matches in the messages searched so far."
          : undefined
      }
    />
  );
}

/** The existing message search owns debounce, cancellation and channel access. */
function BuzzResults(props: Contents & { session: RelaySession }) {
  const { session, query, sync } = props;
  const search = useSearchMessages(session, query);
  const [previous, setPrevious] = useState<{
    session: RelaySession;
    messages: typeof search.messages;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hook projects a new array each render; IDs identify its completed page.
  useEffect(() => {
    if (!search.loading && !search.error && !search.tooShort) {
      setPrevious({ session, messages: search.messages });
    }
  }, [
    session,
    search.loading,
    search.error,
    search.tooShort,
    search.messages.map((message) => message.id).join(","),
  ]);
  const messages =
    (search.loading || search.error) && previous?.session === session
      ? previous.messages
      : search.messages;
  const docs = messages
    .filter((message) => {
      const channel = session.channels.get?.(message.channelId);
      return channel && !channel.huddle && !channel.metadataPending;
    })
    .map((message): FinderDoc => {
      const channel = session.channels.get?.(message.channelId);
      return {
        id: message.id,
        channelId: message.channelId,
        authorId: message.authorId,
        createdAt: message.createdAt,
        author:
          message.authorId === session.viewer
            ? "You"
            : (session.profiles.snapshot().get(message.authorId)?.name ??
              message.authorId.slice(0, 10)),
        place:
          channel?.channelType === "stream" || channel?.channelType === "forum"
            ? `#${channel.name}`
            : channel?.name || "Conversation",
        text: message.text,
      };
    });
  // Only fresh completed hits enter the session index. Public previews stay out.
  const freshKey = search.messages.map((message) => message.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync owns relabeling; index each fresh page once, never retained refresh results.
  useEffect(() => {
    if (!search.loading && !search.error) sync?.remember(docs);
  }, [sync, session, search.loading, search.error, freshKey]);
  const ranked = createCorpus();
  ranked.add(docs);
  const results = ranked.search(query, docs.length || 1);
  const matched = new Set(results.hits.map(({ doc }) => doc.id));
  const all = {
    total: docs.length,
    hits: [
      ...results.hits,
      ...docs
        .filter((doc) => !matched.has(doc.id))
        .map((doc) => ({ doc, score: 0, positions: [] })),
    ],
  };
  const retry = search.error ? search.retry : search.loadMore;
  const error = search.error || search.moreError;
  return (
    <Choices
      {...props}
      results={all}
      busy={search.loading || search.loadingMore}
      empty={
        !query.trim() || search.tooShort
          ? "Type at least three letters in the last word to search Buzz."
          : search.onlyExclusions
            ? "Add a word to search for."
            : search.ambiguousAuthor
              ? "More than one person has that name. Try a different search."
              : search.loading || error
                ? ""
                : `No messages in Buzz match “${query}”. Try another word.`
      }
      footer={
        <LoadingRegion
          pending={search.loading || search.loadingMore}
          label="Searching Buzz…"
          feedback={
            error ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 px-3 text-body-sm text-subtle"
              >
                <span>Messages could not load. Try again.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    props.input.current?.focus();
                    retry();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : undefined
          }
        >
          {search.hasMore && (
            <Button
              size="sm"
              variant="ghost"
              disabled={search.loadingMore}
              onClick={() => {
                props.input.current?.focus();
                search.loadMore();
              }}
            >
              More messages
            </Button>
          )}
        </LoadingRegion>
      }
    />
  );
}

function Choices({
  results,
  footer,
  busy,
  empty,
  ...props
}: Contents & {
  results: FinderResults;
  footer?: ReactNode;
  busy?: boolean;
  empty?: string | undefined;
}) {
  const {
    query,
    setQuery,
    input,
    session,
    scope,
    onScopeChange,
    currentChannelId,
    onOpenChange,
    openMessage,
    corpus,
  } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: previews must not cross sessions.
  const previews = useMemo<PreviewCache>(() => new Map(), [session]);
  const profiles = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    session?.profiles.snapshot ?? noProfiles,
  );
  const byId = new Map(results.hits.map((hit) => [hit.doc.id, hit.doc]));
  const rows: SearchDestination[] = results.hits.map(({ doc, positions }) => {
    const shown = excerpt(doc.text, positions);
    return {
      key: doc.id,
      label: shown.text || "Attachment",
      ...(shown.matches.length ? { matches: shown.matches } : {}),
      detail: `${doc.place} · ${doc.authorId === session?.viewer ? "You" : (profiles.get(doc.authorId)?.name ?? doc.author)} · ${formatItemTimestamp(doc.createdAt)}`,
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(profiles.get(doc.authorId)?.picture, session?.media),
        shape: "circle",
        name: doc.author,
      },
      peek: {
        kind: "message",
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
  const changeScope = (next: FinderScope) => {
    onScopeChange(next);
    input.current?.focus();
  };
  const groups: SearchGroup[] = [
    {
      label: query.trim() ? "Matches" : "Recent",
      destinations: rows,
      total: rows.length,
      count:
        results.total > rows.length
          ? `${rows.length} of ${results.total.toLocaleString()}`
          : undefined,
      empty:
        empty ??
        (corpus.size
          ? "Nothing matches. Try fewer letters, or drop a word."
          : "No messages indexed yet."),
    },
  ];
  const scopes: SearchDestination[] = [];
  if (currentChannelId && !scope)
    scopes.push({
      key: "finder:channel",
      label: "Search this channel",
      icon: ChatCircleIcon,
      run: () => changeScope("channel"),
    });
  if (!scope && session && messageSearchable(query))
    scopes.push({
      key: "finder:buzz",
      label: `Search all of Buzz for “${query}”`,
      icon: ChatCircleIcon,
      run: () => changeScope("buzz"),
    });
  if (scopes.length) groups.push({ label: "Search in", destinations: scopes });
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !word.startsWith("!"))
    .map((word) => word.replace(/^'/, ""));
  return (
    <SearchChoices
      label="Find in your conversations"
      query={query}
      onQueryChange={setQuery}
      input={input}
      open={props.open}
      highlightEmpty
      groups={groups}
      footer={footer}
      isAction={(key) => key.startsWith("finder:")}
      scope={
        scope
          ? {
              id: scope,
              label: scope === "channel" ? "This channel" : "All of Buzz",
              onRemove: () => changeScope(undefined),
            }
          : undefined
      }
      peek={{
        ranked: false,
        busy: !!busy,
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
  );
}
