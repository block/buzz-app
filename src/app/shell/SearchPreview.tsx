import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ReadFilter } from "../../features/relay/events";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { termMatches } from "../../features/search/snippet";
import { avatarMedia } from "../../shared/avatar-source";
import { formatItemTimestamp } from "../../shared/datetime";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { SearchDestination, SearchTone } from "./SearchChoices";
import { SEARCH_KINDS, searchText } from "./useSearchMessages";

/** What the preview beside a highlighted row reads to show it. */
export type PeekTarget =
  | {
      kind: "message";
      channelId: string;
      messageId: string;
      createdAt: number;
      authorId: string;
      text: string;
    }
  | { kind: "channel"; channelId: string; about?: string | undefined }
  | { kind: "person"; pubkey: string };

type Line = {
  id: string;
  channelId: string;
  authorId: string;
  createdAt: number;
  text: string;
};

/** The pause on a row before its preview reads anything, so moving through
 * rows reads only where someone stops. */
const DWELL = 150;
const cache = new WeakMap<RelaySession, Map<string, readonly Line[]>>();

const keyOf = (target: PeekTarget) =>
  target.kind === "message"
    ? `m:${target.messageId}`
    : target.kind === "channel"
      ? `c:${target.channelId}`
      : `p:${target.pubkey}`;

function linesOf(events: readonly { [key: string]: unknown }[]): Line[] {
  return events.flatMap((raw) => {
    const event = raw as {
      id: string;
      kind: number;
      pubkey: string;
      created_at: number;
      content: string;
      tags: readonly (readonly string[])[];
    };
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!channelId || !SEARCH_KINDS.includes(event.kind)) return [];
    return [
      {
        id: event.id,
        channelId,
        authorId: event.pubkey,
        createdAt: event.created_at,
        text: searchText(event) || "Attachment",
      },
    ];
  });
}

async function readLines(
  session: RelaySession,
  target: PeekTarget,
  signal: AbortSignal,
): Promise<readonly Line[]> {
  const read = async (filter: ReadFilter) =>
    linesOf(
      (
        await session.readPage([filter], {
          signal,
          priority: "foreground",
        })
      ).events as never,
    );
  if (target.kind === "message") {
    const where = { kinds: SEARCH_KINDS, "#h": [target.channelId] };
    const [before, after] = await Promise.all([
      read({ ...where, until: target.createdAt, limit: 3 }),
      read({
        ...where,
        since: target.createdAt,
        until: target.createdAt + 6 * 3600,
        limit: 20,
      }),
    ]);
    const earlier = before
      .filter(({ id }) => id !== target.messageId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 2)
      .reverse();
    const later = after
      .filter(({ id }) => id !== target.messageId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 2);
    return [
      ...earlier,
      {
        id: target.messageId,
        channelId: target.channelId,
        authorId: target.authorId,
        createdAt: target.createdAt,
        text: target.text,
      },
      ...later,
    ];
  }
  const latest = await read(
    target.kind === "channel"
      ? { kinds: SEARCH_KINDS, "#h": [target.channelId], limit: 3 }
      : { kinds: SEARCH_KINDS, authors: [target.pubkey], limit: 6 },
  );
  return latest
    .filter(({ channelId }) => !!session.channels.get?.(channelId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);
}

function useLines(session: RelaySession, target: PeekTarget | undefined) {
  const key = target ? keyOf(target) : "";
  const known = cache.get(session)?.get(key);
  const [state, setState] = useState<{
    key: string;
    lines?: readonly Line[];
    failed?: boolean;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: The key names the target.
  useEffect(() => {
    if (!target || known) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readLines(session, target, controller.signal)
        .then((lines) => {
          if (controller.signal.aborted) return;
          const saved = cache.get(session) ?? new Map();
          cache.set(session, saved);
          saved.set(key, lines);
          setState({ key, lines });
          void session.profiles
            .ensure(
              [...new Set(lines.map((line) => line.authorId))],
              "background",
            )
            .catch(() => {});
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ key, failed: true });
        });
    }, DWELL);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, key]);
  const failed = !known && state?.key === key && !!state.failed;
  return {
    lines: known ?? (state?.key === key ? state.lines : undefined),
    failed,
  };
}

const when = (createdAt: number) =>
  formatItemTimestamp(createdAt, { withTime: true });

/** A short look at the highlighted row: enough to tell it is the right one
 * without opening it. */
export function SearchPreview({
  session,
  row,
  tone,
  terms,
  nameOf,
  whereOf,
}: {
  session: RelaySession;
  row: (SearchDestination & { peek?: PeekTarget | undefined }) | undefined;
  tone: SearchTone | undefined;
  terms: readonly string[];
  nameOf: (pubkey: string, channelId?: string) => string;
  whereOf: (channelId: string) => string;
}) {
  // Names and pictures resolve as their profiles arrive.
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const target = row?.peek;
  const { lines, failed } = useLines(session, target);
  if (!row) return <p className="search-peek-empty">Nothing highlighted</p>;
  const message = target?.kind === "message" ? target : undefined;
  const Icon = (message ? row.detailIcon : undefined) ?? row.icon;
  const pictureOf = (pubkey: string) =>
    avatarMedia(profiles.get(pubkey)?.picture, session.media);
  // The hit stands in while its neighbours load.
  const shown: readonly Line[] =
    lines ??
    (message
      ? [
          {
            id: message.messageId,
            channelId: message.channelId,
            authorId: message.authorId,
            createdAt: message.createdAt,
            text: message.text,
          },
        ]
      : []);
  return (
    <div className="search-peek-card">
      <div className="search-peek-head">
        {row.avatar && !message ? (
          <Avatar
            alt=""
            fallback={row.avatar.name ?? row.label}
            src={row.avatar.src}
            size="default"
            shape={row.avatar.shape}
          />
        ) : (
          <span
            className="search-peek-tile"
            data-size="large"
            data-tone={message ? "channel" : tone}
            aria-hidden="true"
          >
            {Icon && <Icon size={18} />}
          </span>
        )}
        <div className="min-w-0">
          <div className="search-peek-title text-label">
            {message ? (
              whereOf(message.channelId)
            ) : (
              <MatchedLabel label={row.label} positions={row.matches} />
            )}
          </div>
          <div className="truncate text-caption text-subtle">
            {message ? when(message.createdAt) : row.detail}
          </div>
        </div>
      </div>
      {!target && row.action && (
        <p className="search-peek-start m-0 text-body-sm text-subtle">
          <span aria-hidden="true">
            <kbd>↵</kbd>
          </span>{" "}
          {row.action}
        </p>
      )}
      {target?.kind === "channel" && target.about && (
        <p className="search-peek-about text-body-sm">{target.about}</p>
      )}
      {target && !message && shown.length > 0 && (
        <div className="text-caption text-subtle">Latest</div>
      )}
      {shown.length > 0 && (
        <ol className="search-peek-lines">
          {shown.map((line) => {
            const hit = !!message && line.id === message.messageId;
            const text = line.text.slice(0, 1600);
            return (
              <li
                key={line.id}
                className="search-peek-line"
                data-hit={hit || undefined}
                data-context={(!!message && !hit) || undefined}
              >
                <Avatar
                  alt=""
                  fallback={nameOf(line.authorId, line.channelId)}
                  src={pictureOf(line.authorId)}
                  size="small"
                  shape="circle"
                />
                <div className="min-w-0">
                  <div className="search-peek-line-head text-caption">
                    <span className="search-peek-author">
                      {nameOf(line.authorId, line.channelId)}
                    </span>
                    {target?.kind === "person" && (
                      <span className="truncate text-subtle">
                        {whereOf(line.channelId)}
                      </span>
                    )}
                    <time className="text-subtle">{when(line.createdAt)}</time>
                  </div>
                  <div className="search-peek-text text-body-sm">
                    <MatchedLabel
                      label={text}
                      positions={
                        hit || !message ? termMatches(text, terms) : undefined
                      }
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {failed && <p className="search-peek-empty">Couldn’t load a preview.</p>}
      {target && !message && lines?.length === 0 && (
        <p className="search-peek-empty">No recent messages.</p>
      )}
    </div>
  );
}
