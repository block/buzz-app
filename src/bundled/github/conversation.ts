import { useEffect, useRef, useState } from "react";
import type { ConversationMessage } from "./GitHubConversation";

export type ConversationEntry = ConversationMessage & {
  id: number;
  state?: string | undefined;
};
export type ConversationEvent = {
  key: string;
  message: ConversationEntry;
  kind: "discussion" | "review";
};
export type ConversationSource = "discussion" | "reviews";
const pageSize = 30;

function endpoint(url: string, source: ConversationSource) {
  const path = new URL(url).pathname.replace(
    "/pull/",
    source === "discussion" ? "/issues/" : "/pulls/",
  );
  return `https://api.github.com/repos${path}/${source === "reviews" ? "reviews" : "comments"}`;
}

type EntryData = {
  id: number;
  user?: { login?: string; avatar_url?: string } | null;
  body?: string | null;
  body_html?: string | null;
  created_at?: string;
  submitted_at?: string | null;
  state?: string;
};

export async function loadConversationPage(
  url: string,
  source: ConversationSource,
  page: number,
  signal: AbortSignal,
) {
  const base = endpoint(url, source);
  const request = new URL(base);
  request.searchParams.set("per_page", String(pageSize));
  request.searchParams.set("page", String(page));
  const response = await fetch(request.href, {
    signal,
    credentials: "omit",
    headers: { Accept: "application/vnd.github.full+json" },
  });
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub’s public API limit was reached. Try again later."
        : `GitHub couldn’t load this source (${response.status}).`,
    );
  const data: EntryData[] = await response.json();
  if (!Array.isArray(data))
    throw new Error("GitHub returned an unreadable conversation page.");
  const entries = data
    .filter(
      (entry) =>
        Number.isSafeInteger(entry?.id) &&
        (source !== "reviews" || !!entry.submitted_at),
    )
    .map((entry): ConversationEntry => {
      const author = entry.user?.login ?? "";
      const date = source === "reviews" ? entry.submitted_at : entry.created_at;
      return {
        id: entry.id,
        author,
        authorUrl: /^[a-z0-9-]+$/i.test(author)
          ? `https://github.com/${encodeURIComponent(author)}`
          : undefined,
        authorAvatar: /^https:\/\/avatars\.githubusercontent\.com\//.test(
          entry.user?.avatar_url ?? "",
        )
          ? entry.user?.avatar_url
          : undefined,
        createdAt: date && Number.isFinite(Date.parse(date)) ? date : undefined,
        body: entry.body ?? "",
        bodyHtml: entry.body_html ?? undefined,
        state: entry.state,
      };
    });
  // The Link header tells us whether another page exists; never follow arbitrary URLs.
  const nextLink = response.headers
    .get("link")
    ?.split(",")
    .find((link) => /;\s*rel="next"/.test(link));
  let next: number | undefined;
  if (nextLink) {
    const link = /^\s*<([^>]+)>/.exec(nextLink)?.[1];
    if (!link) throw new Error("GitHub returned an unreadable next-page link.");
    const parsed = new URL(link);
    const candidate = Number(parsed.searchParams.get("page"));
    if (`${parsed.origin}${parsed.pathname}` !== base || candidate !== page + 1)
      throw new Error("GitHub returned an unexpected next-page link.");
    next = candidate;
  }
  return { entries, next };
}

/** Each collection has its own request, page cursor and recovery state. */
export function useConversationSource(url: string, source: ConversationSource) {
  const [result, setResult] = useState<{
    entries: ConversationEntry[];
    next?: number | undefined;
    loading: boolean;
    error?: string | undefined;
  }>({ entries: [], loading: true });
  const [request, setRequest] = useState({ page: 1, attempt: 0 });
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    busy.current = true;
    setResult((old) => ({ ...old, loading: true, error: undefined }));
    void loadConversationPage(
      url,
      source,
      request.page,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    )
      .then(({ entries, next }) => {
        if (controller.signal.aborted) return;
        setResult((old) => ({
          entries: [
            ...new Map(
              [...old.entries, ...entries].map((entry) => [entry.id, entry]),
            ).values(),
          ],
          next,
          loading: false,
        }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult((old) => ({
            ...old,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      })
      .finally(() => {
        if (!controller.signal.aborted) busy.current = false;
      });
    return () => controller.abort();
  }, [url, source, request]);
  return {
    ...result,
    loadMore: () => {
      if (!busy.current && result.next)
        setRequest({ page: result.next, attempt: 0 });
    },
    retry: () => {
      if (!busy.current)
        setRequest({ ...request, attempt: request.attempt + 1 });
    },
  };
}

function chronological(a: ConversationEntry, b: ConversationEntry) {
  return (
    (Date.parse(a.createdAt ?? "") || 0) -
      (Date.parse(b.createdAt ?? "") || 0) || a.id - b.id
  );
}

export function conversationEvents(
  discussion: ConversationEntry[],
  reviews: ConversationEntry[],
): ConversationEvent[] {
  return [
    ...discussion.map(
      (message): ConversationEvent => ({
        key: `discussion-${message.id}`,
        message,
        kind: "discussion",
      }),
    ),
    // This conversation-level pane deliberately omits inline code threads:
    // loading and grouping them adds an API request and code-level UI. Leave
    // that fuller flow on GitHub; empty comment-only reviews have no summary
    // to show here. Keep the source entries intact so paging still works.
    ...reviews
      .filter(
        (message) => message.state !== "COMMENTED" || !!message.body.trim(),
      )
      .map(
        (message): ConversationEvent => ({
          key: `review-${message.id}`,
          message,
          kind: "review",
        }),
      ),
  ].sort(
    (a, b) => chronological(a.message, b.message) || a.key.localeCompare(b.key),
  );
}
