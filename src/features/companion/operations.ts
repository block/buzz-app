import type { ComposerSession } from "../messages/composer-session";
import type { ReactionSession } from "../messages/MessageReactions";
import type { CustomEmoji } from "../relay/emoji";
import type { Delivery, OutgoingEvent } from "../relay/outbox";

/** One of main's outbox operations in this window's channel, as projected. */
export type MainOperation = {
  id: string;
  /** The message it changes, when main can tell (reaction, removal, edit or
   * sent-to-channel copy target). */
  messageId?: string | undefined;
  kind: 7 | 5 | 40003 | 9;
  delivery: Delivery;
  error?: string | undefined;
};
/** What main answers when it admits an operation: the outbox event id it will
 * carry and the projection version at that moment. Main keeps projecting an
 * admitted operation, whatever its delivery, until it has reported it
 * delivered once, so the companion never has to infer anything from absence. */
export type Admission = { id: string; version: number };
/** The bridge a companion operates through; the composer client provides it. */
export type OperationBridge = {
  react(args: {
    messageId: string;
    content: string;
    emoji?: CustomEmoji | undefined;
  }): Promise<Admission>;
  removeReactions(args: {
    messageId: string;
    ids: readonly string[];
  }): Promise<Admission>;
  deleteMessage(args: { messageId: string }): Promise<Admission>;
  edit(args: {
    messageId: string;
    content: string;
    attachmentSourceId: string;
    baseline: string;
  }): Promise<Admission>;
  sendToChannel(args: { messageId: string }): Promise<Admission>;
  retryOperation(args: { id: string }): Promise<undefined>;
};
type Local = {
  item: OutgoingEvent;
  run(): Promise<Admission>;
  /** Set once main admitted it: main's event id and the version then. */
  admitted?: Admission | undefined;
};

/**
 * The outbox a companion window operates through. Shared controls expect a
 * synchronous operation id they can follow in an outbox until delivery; here
 * each request keeps that **local** id for its whole life: pending until main
 * answers, failed with main's refusal, then — once admitted — mirroring main's
 * own operation (projected with the window, in every state, until main has
 * reported it delivered) until that terminal report. A projection may arrive
 * before the admission reply and projections may be reordered, so the latest
 * known status of every main operation is kept and reconciled on both paths;
 * an older projection never regresses state. Main's operations the companion
 * did not start (another window's, or from before a reload) are shown too, so
 * recovery is never hidden by row withdrawal or projection lag.
 */
export function createCompanionOperations(
  session: ComposerSession,
  bridge: OperationBridge,
  /** From the rows shown now: the message a reaction event id belongs to,
   * and a message's current source text (the edit baseline main must still
   * see). */
  rows: {
    messageOf(eventId: string): string | undefined;
    sourceOf(messageId: string): string | undefined;
  },
): ReactionSession & {
  dispose(): void;
  setMainOperations(
    operations: readonly MainOperation[],
    version: number,
  ): void;
  messages: ReactionSession["messages"] & {
    edit(
      messageId: string,
      content: string,
      attachmentSourceId: string,
    ): string;
    deleteMessage(messageId: string): string;
    sendToChannel(messageId: string): string;
  };
} {
  const locals = new Map<string, Local>();
  // Latest status main reported for each of its operations, by main id.
  const latest = new Map<string, MainOperation>();
  let latestVersion = -1;
  let foreign: readonly OutgoingEvent[] = [];
  let operations: readonly OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  let disposed = false;
  let next = 0;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const recompute = () => {
    operations = [
      ...[...locals.values()].map((local) => local.item),
      ...foreign,
    ];
    publish();
  };
  const patch = (local: Local, change: Partial<OutgoingEvent>) => {
    local.item = { ...local.item, ...change };
  };
  function start(local: Local) {
    patch(local, { delivery: "sending", error: undefined });
    recompute();
    void local.run().then(
      (admission) => {
        if (disposed) return;
        local.admitted = admission;
        // A projection may already have reported this operation.
        reconcile(local);
        recompute();
      },
      (cause: unknown) => {
        if (disposed) return;
        patch(local, {
          delivery: "failed",
          error:
            cause instanceof Error
              ? cause.message
              : "Could not complete this change. Try again.",
        });
        recompute();
      },
    );
  }
  /** Mirror main's latest status for an admitted local; done when terminal. */
  function reconcile(local: Local) {
    const admitted = local.admitted;
    if (!admitted) return;
    const mirrored = latest.get(admitted.id);
    if (!mirrored) return;
    patch(local, { delivery: mirrored.delivery, error: mirrored.error });
    if (mirrored.delivery === "accepted" || mirrored.delivery === "seen")
      locals.delete(local.item.event.id);
  }
  function enqueue(
    kind: MainOperation["kind"],
    messageId: string,
    content: string,
    tags: string[][],
    run: () => Promise<Admission>,
  ) {
    const id = `companion-op-${++next}`;
    const local: Local = {
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
    locals.set(id, local);
    start(local);
    return id;
  }
  const outbox: NonNullable<ComposerSession["outbox"]> = {
    supports: (kind) =>
      [7, 5, 40003].includes(kind) || !!session.outbox?.supports(kind),
    snapshot: () => operations,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry(id) {
      const local = locals.get(id);
      if (local && !local.admitted) {
        start(local);
        return;
      }
      // Main's event (ours after admission, or one we only see): main retries
      // exactly that event; a refusal shows on it until the next projection.
      const mainId = local?.admitted?.id ?? id;
      void bridge.retryOperation({ id: mainId }).catch((cause: unknown) => {
        if (disposed) return;
        const error =
          cause instanceof Error ? cause.message : "Could not retry this.";
        if (local) patch(local, { delivery: "failed", error });
        else
          foreign = foreign.map((item) =>
            item.event.id === id
              ? { ...item, delivery: "failed", error }
              : item,
          );
        recompute();
      });
    },
  };
  const messageIdFor = (ids: readonly string[]) => {
    for (const id of ids) {
      const owner = rows.messageOf(id);
      if (owner) return owner;
    }
    return undefined;
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
      deleteMessage: (messageId) =>
        enqueue(5, messageId, "", [], () =>
          bridge.deleteMessage({ messageId }),
        ),
      edit: (messageId, content, attachmentSourceId) => {
        // The baseline main must still see; the composer validated against it.
        const baseline = rows.sourceOf(messageId) ?? "";
        return enqueue(40003, messageId, content, [], () =>
          bridge.edit({ messageId, content, attachmentSourceId, baseline }),
        );
      },
      sendToChannel: (messageId) =>
        enqueue(9, messageId, "", [["buzz:copy-of", messageId]], () =>
          bridge.sendToChannel({ messageId }),
        ),
      reactionTarget: (event) =>
        event.kind === 7 || event.kind === 5 || event.kind === 40003
          ? event.tags.find(([name]) => name === "e")?.[1]
          : event.kind === 9
            ? event.tags.find(([name]) => name === "buzz:copy-of")?.[1]
            : undefined,
    },
    setMainOperations(main, version) {
      if (disposed || version < latestVersion) return;
      latestVersion = version;
      // Remember every status seen; a later projection updates, never erases.
      for (const op of main) latest.set(op.id, op);
      for (const local of [...locals.values()]) reconcile(local);
      const mine = new Set(
        [...locals.values()].flatMap((local) =>
          local.admitted ? [local.admitted.id] : [],
        ),
      );
      foreign = main
        .filter(
          (op) =>
            !mine.has(op.id) &&
            op.delivery !== "accepted" &&
            op.delivery !== "seen",
        )
        .map((op) => ({
          event: {
            id: op.id,
            pubkey: session.viewer ?? "",
            created_at: 0,
            kind: op.kind,
            content: "",
            tags: op.messageId
              ? [[op.kind === 9 ? "buzz:copy-of" : "e", op.messageId]]
              : [],
          },
          delivery: op.delivery,
          ...(op.error ? { error: op.error } : {}),
        }));
      recompute();
    },
    dispose() {
      disposed = true;
      locals.clear();
      latest.clear();
      foreign = [];
      operations = [];
      listeners.clear();
    },
  };
}
