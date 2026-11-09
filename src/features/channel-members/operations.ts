import type { MemberAdditionIntent } from "./members";
import type { Delivery, LocalEvents } from "../relay/outbox";
import { failsAgain, failureText, NamedError } from "../relay/refusal";

type Addition = Readonly<{
  channelId: string;
  pubkey: string;
  pending: boolean;
  confirmed: boolean;
  error?: string;
  /** `error` names the person already. */
  named?: true;
  /** Sending it again would fail the same way, so there is no Retry. */
  final?: true;
}>;

/** Session-owned continuation and recovery; closing a view never cancels intent. */
export function createMemberAdditions(
  signal: AbortSignal,
  add: (
    channelId: string,
    pubkey: string,
    intent: MemberAdditionIntent,
  ) => Promise<void>,
  receipts?: LocalEvents,
  /** Adds several people at once; returns who the roster then shows. */
  addAtOnce?: (
    channelId: string,
    pubkeys: readonly string[],
    intents: ReadonlyMap<string, MemberAdditionIntent>,
  ) => Promise<ReadonlySet<string>>,
  /** The name people know someone by, for messages about them. */
  nameOf: (pubkey: string) => string | undefined = () => undefined,
) {
  let snapshot: readonly Addition[] = [];
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<void>>();
  const intents = new Map<string, MemberAdditionIntent>();
  /** Additions to a channel requested in the same turn share one batch. */
  const batches = new Map<
    string,
    {
      people: Map<string, MemberAdditionIntent>;
      shown: Promise<ReadonlySet<string>>;
    }
  >();
  function batch(
    channelId: string,
    pubkey: string,
    intent: MemberAdditionIntent,
  ) {
    let current = batches.get(channelId);
    if (!current) {
      const people = new Map<string, MemberAdditionIntent>();
      const shown = Promise.resolve().then(() => {
        batches.delete(channelId);
        return people.size > 1 && addAtOnce
          ? addAtOnce(channelId, [...people.keys()], people)
          : new Set<string>();
      });
      current = { people, shown };
      batches.set(channelId, current);
    }
    current.people.set(pubkey, intent);
    return current.shown;
  }
  const stopReceipts = trackMemberAdditionReceipts(receipts, () =>
    intents.values(),
  );
  function publish(next: readonly Addition[]) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  signal.addEventListener(
    "abort",
    () => {
      stopReceipts?.();
      intents.clear();
      publish([]);
      listeners.clear();
    },
    { once: true },
  );
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(
      channelId: string,
      pubkey: string,
      options: { role?: "guest"; retry?: true } = {},
    ): Promise<void> {
      if (signal.aborted)
        return Promise.reject(new Error("The community connection closed."));
      const key = JSON.stringify([channelId, pubkey]);
      const existing = pending.get(key);
      // An addition under way keeps the role it asked for; another role
      // waits for it rather than joining it or racing it with a second write.
      if (existing) {
        if (
          intents.get(key)?.role !== options.role ||
          intents.get(key)?.retry !== options.retry
        )
          return Promise.reject(
            new NamedError(
              `Buzz is still adding ${nameOf(pubkey) ?? "this person"}. Wait for that to finish, then try again.`,
            ),
          );
        return existing;
      }
      const matches = (item: Addition) =>
        item.channelId === channelId && item.pubkey === pubkey;
      const previous = snapshot.find(matches);
      const intent = intents.get(key) ?? {};
      intents.set(key, intent);
      if (options.role) intent.role = options.role;
      else delete intent.role;
      if (options.retry) intent.retry = true;
      else delete intent.retry;
      let confirmed = previous?.confirmed ?? false;
      // Retry only finishes an existing receipt, so it never joins a batch.
      const shown =
        confirmed || options.retry || !addAtOnce
          ? undefined
          : batch(channelId, pubkey, intent);
      const update = (item?: Addition) => {
        if (!signal.aborted)
          publish([
            ...snapshot.filter((value) => !matches(value)),
            ...(item ? [item] : []),
          ]);
      };
      const operation = Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          if (!confirmed) {
            if ((await shown?.catch(() => undefined))?.has(pubkey))
              intent.confirmed = true;
            else await add(channelId, pubkey, intent);
            confirmed = true;
          }
          signal.throwIfAborted();
          update();
        })
        .catch((error: unknown) => {
          update({
            channelId,
            pubkey,
            pending: false,
            confirmed,
            error: failureText(error, "Buzz couldn’t add them. Try again."),
            ...(error instanceof NamedError ? { named: true as const } : {}),
            ...(failsAgain(error) ? { final: true as const } : {}),
          });
          throw error;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, operation);
      update({ channelId, pubkey, pending: true, confirmed });
      return operation;
    },
    /** Drops a settled addition's message, as when the person is in the
     * channel after all or has read it. An addition under way keeps its
     * entry; what a later add would finish stays with its intent. */
    dismiss(channelId: string, pubkey: string) {
      if (signal.aborted || pending.has(JSON.stringify([channelId, pubkey])))
        return;
      const next = snapshot.filter(
        (item) => item.channelId !== channelId || item.pubkey !== pubkey,
      );
      if (next.length !== snapshot.length) publish(next);
    },
  });
}

/** Only observed failed receipts can become explicit dismissals. Missing accepted
 * or unknown evidence must never authorize a replacement membership write. */
export function trackMemberAdditionReceipts(
  receipts: LocalEvents | undefined,
  intents: () => Iterable<MemberAdditionIntent>,
) {
  const deliveries = new WeakMap<MemberAdditionIntent, Delivery>();
  return receipts?.subscribe(() => {
    const current = new Map(
      receipts.snapshot().map((item) => [item.event.id, item.delivery]),
    );
    for (const intent of intents()) {
      if (!intent.id) continue;
      const delivery = current.get(intent.id);
      // Failed outstanding records are removed only by durable explicit dismissal.
      // Completed echoes can be evicted, so their absence never permits a new send.
      if (
        !delivery &&
        !intent.confirmed &&
        deliveries.get(intent) === "failed"
      ) {
        deliveries.delete(intent);
        intent.dismissed = true;
      } else if (delivery) deliveries.set(intent, delivery);
    }
  });
}
