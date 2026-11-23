import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import type { OwnPostsState } from "../../features/relay/own-posts";
import type { Engagement } from "./sidebar-sections";

const keptKey = "kept-chats";
const MAX_KEPT = 1000;

function parseKept(revision: string | null | undefined): readonly string[] {
  try {
    const saved: unknown = JSON.parse(revision ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** Conversations the viewer moved from Shared with you into Chats, newest
 * last. Device-local for now: another device decides for itself. */
export const readKeptChats = (scope: string) =>
  parseKept(viewRevision(scope, keptKey));

export function keepChat(scope: string, channelId: string) {
  const kept = readKeptChats(scope);
  if (kept.includes(channelId)) return;
  writeView(scope, keptKey, [...kept, channelId].slice(-MAX_KEPT));
}

function build(
  viewer: string,
  agents: readonly string[],
  posts: OwnPostsState,
  kept: readonly string[],
): Engagement {
  return {
    mine: new Set([viewer, ...agents]),
    posted: posts.status === "ready" ? posts.channels : undefined,
    kept: new Set(kept),
  };
}

/** What the sidebar needs to split named conversations between Chats and
 * Shared with you: whose they are, where the viewer has posted and what they
 * kept. `read` rebuilds it for callers that act before React re-renders. */
export function useEngagement(
  session: RelaySession,
  scope: string,
  viewer: string | undefined,
  /** Ask for the posted channels once the roster is up; asking again after a
   * failure retries it. */
  rosterReady: boolean,
) {
  const posts = useSyncExternalStore(
    session.ownPosts.subscribe,
    session.ownPosts.snapshot,
    session.ownPosts.snapshot,
  );
  useEffect(() => {
    if (rosterReady) void session.ownPosts.ensure();
  }, [session, rosterReady]);
  // The viewer's own agents count as the viewer. Passive: this reads what the
  // session already knows and never starts an inventory read.
  const agents = useSyncExternalStore(session.agentChoices.subscribe, () =>
    session.agentChoices
      .snapshot()
      .identities.map(({ pubkey }) => pubkey)
      .sort()
      .join(","),
  );
  const keptRevision = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify, keptKey), [scope]),
    () => viewRevision(scope, keptKey),
  );
  const engagement = useMemo(
    () =>
      viewer
        ? build(
            viewer,
            agents ? agents.split(",") : [],
            posts,
            parseKept(keptRevision),
          )
        : undefined,
    [viewer, agents, posts, keptRevision],
  );
  /** The same, read now, for callers that act before React re-renders. */
  const read = useCallback(
    () =>
      viewer
        ? build(
            viewer,
            session.agentChoices.snapshot().identities.map((a) => a.pubkey),
            session.ownPosts.snapshot(),
            readKeptChats(scope),
          )
        : undefined,
    [session, scope, viewer],
  );
  return {
    engagement,
    read,
    /** Whether placement is settled, so rows do not move once revealed. */
    settled: posts.status !== "idle" && posts.status !== "loading",
    keep: useCallback(
      (channelId: string) => keepChat(scope, channelId),
      [scope],
    ),
  };
}
