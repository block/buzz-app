import { lazy, Suspense, useRef, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import { relayPartition } from "../../features/relay/partition";
import { activeModal } from "../../shared/design-system/overlayLayer";
import { createCorpus } from "./corpus.ts";
import { noteInterest, topInterest } from "./interest";
import type { FinderScope } from "./FinderDialog";
import {
  type FinderSync,
  type FinderSyncStatus,
  startFinderSync,
} from "./sync";

// Loaded on first open, so the plugin list doesn't pull the dialog and its
// styles into every page that imports it.
const FinderDialog = lazy(() =>
  import("./FinderDialog").then((m) => ({ default: m.FinderDialog })),
);

export const inject = ["pages", "relay", "navigation", "shortcuts"];

type State = Readonly<{
  open: boolean;
  revision: number;
  session?: RelaySession | undefined;
  status?: FinderSyncStatus | undefined;
  sync?: FinderSync | undefined;
  scope?: FinderScope;
}>;

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const corpus = createCorpus();
  const listeners = new Set<() => void>();
  let state: State = { open: false, revision: 0 };
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };

  // Interest in the conversation on screen: 1 per visit, and more when you
  // search in it or open a message from Finder.
  const interested = (weight: number) => {
    const { entry } = ctx.navigation.snapshot();
    if (entry.target.kind !== "conversation") return;
    const { viewer, communityOrigin } = entry.target.scope;
    noteInterest(
      relayPartition(communityOrigin, viewer),
      entry.target.channelId,
      weight,
    );
  };
  const chooseScope = (scope: FinderScope | undefined) => {
    if (scope === "channel") interested(2);
    set({ open: true, scope });
  };
  ctx.effect(() => {
    let visit: string | undefined;
    const visited = () => {
      const { entry } = ctx.navigation.snapshot();
      if (entry.id === visit) return;
      visit = entry.id;
      interested(1);
    };
    visited();
    return ctx.navigation.subscribe(visited);
  });

  // One index per connected session: a new community, account, reconnect
  // generation or Clear cache starts over, and the old one is dropped.
  ctx.effect(() => {
    let current: { key: string; dispose(): void } | undefined;
    const sync = () => {
      const snapshot = relay.snapshot();
      const key =
        snapshot.status === "ready" && !snapshot.cached
          ? `${snapshot.scope}:${snapshot.generation}`
          : "";
      if (key === current?.key) return;
      current?.dispose();
      current = undefined;
      if (!key)
        return set({
          session: undefined,
          status: undefined,
          sync: undefined,
          scope: undefined,
          revision: state.revision + 1,
        });
      const running = startFinderSync({
        session: snapshot.session,
        corpus,
        changed: () =>
          set({ revision: state.revision + 1, status: running.status() }),
        warm: () => (snapshot.scope ? topInterest(snapshot.scope, 24) : []),
      });
      current = { key, dispose: running.dispose };
      set({
        session: snapshot.session,
        status: running.status(),
        sync: running,
        scope: undefined,
        revision: state.revision + 1,
      });
    };
    const stop = relay.subscribe(sync);
    sync();
    return () => {
      stop();
      current?.dispose();
    };
  });

  ctx.shortcuts.register({
    id: "open",
    title: "Find in your conversations",
    binding: { key: "p", mod: true },
    order: 10,
    allowInEditable: true,
    run: () => set({ open: true, scope: undefined }),
  });

  ctx.shortcuts.register({
    id: "channel",
    title: "Find in this channel",
    binding: [
      { key: "p", mod: true, alt: true },
      // Option+P can report π on an Apple keyboard.
      { key: "π", mod: true, alt: true },
    ],
    order: 11,
    allowInEditable: true,
    allowInModal: true,
    when: () =>
      (state.open || !activeModal(document)) &&
      ctx.navigation.snapshot().entry.target.kind === "conversation",
    run: () => chooseScope("channel"),
  });

  ctx.pages.registerOverlay({
    id: "finder",
    component: function Finder() {
      const { open, revision, session, status, sync, scope } =
        useSyncExternalStore(store.subscribe, store.snapshot);
      const target = useSyncExternalStore(
        ctx.navigation.subscribe,
        ctx.navigation.snapshot,
      ).entry.target;
      const currentChannelId =
        target.kind === "conversation" ? target.channelId : undefined;
      const opened = useRef(false);
      if (open) opened.current = true;
      if (!opened.current) return null;
      const count = corpus.size.toLocaleString();
      return (
        <Suspense fallback={null}>
          <FinderDialog
            open={open}
            onOpenChange={(next) => set({ open: next })}
            corpus={corpus}
            revision={revision}
            session={session}
            sync={sync}
            currentChannelId={currentChannelId}
            scope={scope === "channel" && !currentChannelId ? undefined : scope}
            onScopeChange={chooseScope}
            status={
              !session ? (
                <p className="px-3 text-body-sm text-subtle">
                  Connect to a community to search your conversations.
                </p>
              ) : status?.phase === "error" ? (
                <p className="px-3 text-body-sm text-subtle" role="alert">
                  Indexing stopped: {status.error}. {count} messages searchable.
                </p>
              ) : status?.phase !== "ready" ? (
                <p className="px-3 text-body-sm text-subtle" aria-live="polite">
                  Indexing your last 90 days… {count} messages so far.
                </p>
              ) : (
                <p className="px-3 text-body-sm text-subtle">
                  {count} messages indexed. Channels you open add theirs.
                </p>
              )
            }
            openMessage={(doc) => {
              const { viewer, scope } = relay.snapshot();
              if (!viewer || !scope?.endsWith(`:${viewer}`)) return;
              // The visit adds 1; finding it here is worth more.
              noteInterest(scope, doc.channelId, 2);
              void ctx.navigation.open({
                version: 1,
                kind: "conversation",
                scope: {
                  viewer,
                  communityOrigin: scope.slice(0, -(viewer.length + 1)),
                },
                channelId: doc.channelId,
                messageId: doc.id,
                ...(doc.threadRootId && { threadRootId: doc.threadRootId }),
              });
            }}
          />
        </Suspense>
      );
    },
  });
};
