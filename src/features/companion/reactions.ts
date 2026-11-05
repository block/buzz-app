import type { ComposerSession } from "../messages/composer-session";
import type { ReactionSession } from "../messages/MessageReactions";
import type { CustomEmoji } from "../relay/emoji";
import type { OutgoingEvent } from "../relay/outbox";

/** The bridge a companion reacts through; the composer client provides it. */
export type ReactionBridge = {
  react(args: {
    messageId: string;
    content: string;
    emoji?: CustomEmoji | undefined;
  }): Promise<string>;
  removeReactions(args: {
    messageId: string;
    ids: readonly string[];
  }): Promise<undefined>;
};
type Pending = {
  item: OutgoingEvent;
  run(): Promise<unknown>;
};

/**
 * A reaction session for a companion window. The shared reaction controls
 * decide add-versus-remove synchronously and expect an outbox they can watch
 * for pending, failed and retried operations; here each request becomes a
 * local operation that is pending until main answers, failed with its error
 * when main refuses or cannot deliver, and gone once main admitted it (the
 * projected rows then carry the result). The kind-7/kind-5 shape lets the
 * existing `reactionTarget` and recovery UI work unchanged.
 */
export function createCompanionReactions(
  session: ComposerSession,
  bridge: ReactionBridge,
  /** The message a reaction event id belongs to, from the rows shown now. */
  messageOf: (eventId: string) => string | undefined,
): ReactionSession & { dispose(): void } {
  let operations: readonly OutgoingEvent[] = [];
  const pending = new Map<string, Pending>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let next = 0;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const update = (id: string, patch: Partial<OutgoingEvent> | null) => {
    if (disposed) return;
    operations = patch
      ? operations.map((item) =>
          item.event.id === id ? { ...item, ...patch } : item,
        )
      : operations.filter((item) => item.event.id !== id);
    publish();
  };
  function start(entry: Pending) {
    const id = entry.item.event.id;
    update(id, { delivery: "sending", error: undefined });
    void entry.run().then(
      () => {
        pending.delete(id);
        update(id, null);
      },
      (cause: unknown) => {
        update(id, {
          delivery: "failed",
          error:
            cause instanceof Error
              ? cause.message
              : "Could not update reaction. Try again.",
        });
      },
    );
  }
  function enqueue(
    kind: 7 | 5,
    messageId: string,
    content: string,
    tags: string[][],
    run: () => Promise<unknown>,
  ) {
    const id = `companion-reaction-${++next}`;
    const entry: Pending = {
      item: {
        event: {
          id,
          pubkey: session.viewer ?? "",
          created_at: Math.floor(Date.now() / 1000),
          kind,
          content,
          tags: [["e", messageId], ...tags],
        },
        delivery: "sending",
      },
      run,
    };
    pending.set(id, entry);
    operations = [...operations, entry.item];
    start(entry);
    return id;
  }
  const outbox: NonNullable<ComposerSession["outbox"]> = {
    supports: (kind) => kind === 7 || kind === 5,
    snapshot: () => operations,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry(id) {
      const entry = pending.get(id);
      if (entry) start(entry);
    },
  };
  return {
    ...session,
    outbox,
    messages: {
      ...session.messages,
      react: (messageId, content, emoji) =>
        enqueue(7, messageId, content, [], () =>
          bridge.react({ messageId, content, emoji }),
        ),
      remove: (ids) => {
        // The shared toggle removes the viewer's own events on one message;
        // the pending item names that message so recovery can find it.
        const messageId = messageIdFor(ids);
        if (!messageId)
          throw new Error("Load the reaction before removing it.");
        return enqueue(
          5,
          messageId,
          "",
          ids.map((id) => ["e", id]),
          () => bridge.removeReactions({ messageId, ids }),
        );
      },
      reactionTarget: (event) =>
        event.kind === 7 || event.kind === 5
          ? event.tags.find(([name]) => name === "e")?.[1]
          : undefined,
    },
    dispose() {
      disposed = true;
      pending.clear();
      operations = [];
      listeners.clear();
    },
  };
  function messageIdFor(ids: readonly string[]) {
    for (const id of ids) {
      const owner = messageOf(id);
      if (owner) return owner;
    }
    return undefined;
  }
}
