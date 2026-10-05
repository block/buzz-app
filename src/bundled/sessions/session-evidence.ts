import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { VisibleEvent } from "../../features/relay/projection";
import type {
  EventViewSnapshot,
  RelaySession,
} from "../../features/relay/session";
import { threadReference } from "../../features/relay/thread-reference";

export const ROOT_LIMIT = 200;
export const REPLY_LIMIT = 200;
export const PROFILE_LIMIT = 1024;
const keyPattern = /^[0-9a-f]{64}$/;
// Verified event seconds may still exceed the range supported by Date/Intl.
const validMessageTime = (seconds: number) =>
  Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000_000;
const shared = (delivery: ChannelMessage["delivery"]) =>
  delivery === undefined || delivery === "accepted" || delivery === "seen";

/** Current folded roots: edits and local delivery state remain authoritative. */
export function sessionRoots(
  rows: readonly ChannelMessage[],
  channelId: string,
) {
  return rows
    .filter(
      (row) =>
        row.channelId === channelId &&
        !row.threadRootId &&
        !row.membership &&
        keyPattern.test(row.id) &&
        validMessageTime(row.createdAt) &&
        shared(row.delivery),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function rootIdentities(root: ChannelMessage) {
  return [
    root.authorId,
    ...(root.edited && !root.quietSession && !root.chipSession
      ? []
      : root.mentions),
    ...root.participants,
  ].filter((key) => keyPattern.test(key));
}

/** observe() already uses the session's verified remote / local-intent projection.
 * Only shared supported replies count; quote tags and lone roots are not replies.
 * An intermediate-only parent cannot be resolved by this finite root batch. */
export function sessionReplies(
  events: readonly VisibleEvent[],
  channelId: string,
  roots: ReadonlySet<string>,
) {
  return events.slice(0, REPLY_LIMIT).flatMap((event) => {
    if (
      ![9, 40002].includes(event.kind) ||
      !keyPattern.test(event.id) ||
      !validMessageTime(event.created_at) ||
      !shared(event.delivery) ||
      !event.tags.some(([name, value]) => name === "h" && value === channelId)
    )
      return [];
    const reference = threadReference(event);
    if (
      !reference ||
      !roots.has(reference.rootId) ||
      event.id === reference.rootId
    )
      return [];
    return [
      {
        id: event.id,
        createdAt: event.created_at,
        rootId: reference.rootId,
        identities: [
          event.pubkey,
          ...event.tags
            .filter(([name]) => name === "p")
            .map(([, value]) => value ?? ""),
        ].filter((key) => keyPattern.test(key)),
      },
    ];
  });
}

const emptyBatch: EventViewSnapshot = { status: "ready", events: [] };
type Batch = {
  session: RelaySession;
  key: string;
  snapshot: EventViewSnapshot;
  reset: number;
};

/** Tab-scoped bounded evidence, never a transcript reader or an agent authority. */
export function useSessionEvidence(
  session: RelaySession,
  channelId: string,
  roots: readonly ChannelMessage[],
) {
  // Sorting the IDs, not depending on rows/profiles/reply counts, keeps the read stable.
  const rootKey = roots
    .map((root) => root.id)
    .sort()
    .join(":");
  const [batch, setBatch] = useState<Batch>();
  const [allocation, setAllocation] = useState(0);
  const scopeKey = `${channelId}/${rootKey}/${allocation}`;
  const resets = useRef(0);
  const reader = useRef<ReturnType<RelaySession["observe"]> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!rootKey) return;
    let current = true;
    let view: ReturnType<RelaySession["observe"]> | undefined;
    let stop: (() => void) | undefined;
    let previous: EventViewSnapshot | undefined;
    try {
      view = session.observe([
        {
          kinds: [9, 40002],
          "#h": [channelId],
          "#e": rootKey.split(":"),
          limit: REPLY_LIMIT,
        },
      ]);
      reader.current = view;
      const publish = () => {
        if (!current || !view) return;
        const snapshot = view.snapshot();
        if (
          previous &&
          snapshot.status === "idle" &&
          previous.status !== "idle"
        )
          resets.current++;
        previous = snapshot;
        setBatch({ session, key: scopeKey, snapshot, reset: resets.current });
      };
      stop = view.subscribe(publish);
      publish();
      // StrictMode may retire a mount immediately; do not dispatch its read.
      queueMicrotask(() => {
        if (current) void view?.refresh();
      });
    } catch {
      setBatch({
        session,
        key: scopeKey,
        snapshot: { status: "error", events: [] },
        reset: resets.current,
      });
    }
    return () => {
      current = false;
      stop?.();
      view?.dispose();
      if (reader.current === view) reader.current = undefined;
    };
  }, [session, channelId, rootKey, scopeKey]);
  const owned =
    batch?.session === session && batch.key === scopeKey ? batch : undefined;
  const snapshot = !rootKey ? emptyBatch : owned?.snapshot;
  const replies = useMemo(
    () =>
      sessionReplies(
        snapshot?.events ?? [],
        channelId,
        new Set(rootKey.split(":")),
      ),
    [snapshot?.events, channelId, rootKey],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const known = useKnownAgentPubkeys(session, profiles);
  const candidates = [
    ...new Set([
      ...roots.flatMap(rootIdentities),
      ...replies.flatMap((reply) => reply.identities),
    ]),
  ].sort();
  const candidateKey = candidates.join(":");
  // This budget lasts for this channel/tab opening, including retry and live updates.
  const budget = useMemo(
    () => ({
      session,
      channelId,
      keys: new Set<string>(),
      attempted: new Set<string>(),
      pending: new Map<string, Promise<void>>(),
      retry: 0,
      reset: 0,
    }),
    [session, channelId],
  );
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const reset = owned?.reset ?? resets.current;
  const batchIdle = snapshot?.status === "idle";
  useEffect(() => {
    let current = true;
    if (budget.reset !== reset) {
      budget.reset = reset;
      budget.pending.clear();
      budget.attempted.clear();
    }
    if (batchIdle) {
      setPending(false);
      return;
    }
    if (budget.retry !== retry) {
      budget.retry = retry;
      budget.attempted.clear();
    }
    const missing = candidateKey
      .split(":")
      .filter((key) => key && !session.profiles.snapshot().has(key));
    const request = missing.filter((key) => {
      if (!budget.keys.has(key) && budget.keys.size >= PROFILE_LIMIT)
        return false;
      budget.keys.add(key);
      if (budget.attempted.has(key)) return false;
      budget.attempted.add(key);
      return true;
    });
    if (request.length) {
      const work = session.profiles
        .ensure(request, "background")
        .catch(() => {
          // Missing evidence stays unknown until an explicit retry.
        })
        .finally(() => {
          for (const key of request)
            if (budget.pending.get(key) === work) budget.pending.delete(key);
        });
      for (const key of request) budget.pending.set(key, work);
    }
    const waiting = [
      ...new Set(missing.flatMap((key) => budget.pending.get(key) ?? [])),
    ];
    setPending(waiting.length > 0);
    if (waiting.length)
      void Promise.all(waiting).finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [session, candidateKey, budget, retry, reset, batchIdle]);
  const eligible = new Set(
    replies
      .filter((reply) => reply.identities.some((key) => known.has(key)))
      .map((reply) => reply.rootId),
  );
  for (const root of roots)
    if (rootIdentities(root).some((key) => known.has(key)))
      eligible.add(root.id);
  // Recompute from the current bounded sample, not a sticky maximum. Any shared
  // conversational reply can advance an eligible thread, including human follow-ups.
  const latestMessages = new Map<string, number>();
  for (const reply of replies)
    latestMessages.set(
      reply.rootId,
      Math.max(latestMessages.get(reply.rootId) ?? 0, reply.createdAt),
    );
  return {
    profiles,
    known,
    eligible,
    latestMessages,
    loading:
      pending || (!!rootKey && (!snapshot || snapshot.status === "loading")),
    partial:
      (!!rootKey && snapshot?.status !== "ready") ||
      candidates.some((key) => !profiles.has(key) && !known.has(key)) ||
      (snapshot?.events.length ?? 0) >= REPLY_LIMIT,
    retry() {
      if (reader.current) void reader.current.refresh();
      else if (rootKey) setAllocation((value) => value + 1);
      setRetry((value) => value + 1);
    },
  };
}
