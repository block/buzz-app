import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { EventData } from "./events";
import type { Delivery, Outbox } from "./outbox";

export const DM_OPEN_KIND = 41010;
const key = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The single peer of a well-formed one-to-one DM open command. */
function peerOf(event: EventData) {
  if (event.kind !== DM_OPEN_KIND) return;
  const peers = event.tags.filter(([name]) => name === "p");
  return peers.length === 1 ? peers[0]?.[1] : undefined;
}

/** Open or resume one-to-one DMs. Every open sends 41010: the relay resolves the
 * participant set to its canonical DM and clears per-viewer hidden state. That
 * channel is navigation-ready only after the relay-signed roster lists exactly
 * the viewer and peer. */
export function createDirectMessages(
  outbox: Outbox | undefined,
  channels: ChannelQueries,
  viewer: string,
  signal: AbortSignal,
  ready: Promise<void> = Promise.resolve(),
  rosterTimeoutMs = 15_000,
) {
  // Ephemeral receipt evidence: command event ID -> relay channel ID. The
  // outbox reports a receipt before it records any terminal delivery state.
  const receipts = new Map<string, string>();
  const opening = new Map<string, Promise<string>>();
  const available = !!outbox?.supports(DM_OPEN_KIND);

  function listed(peer: string, id: string): ChannelSummary | undefined {
    const list = channels.list();
    if (list.status !== "ready") return;
    return list.channels.find(
      (channel) =>
        channel.id === id &&
        channel.channelType === "dm" &&
        !channel.archived &&
        channel.members?.length === 2 &&
        channel.members.includes(viewer) &&
        channel.members.includes(peer),
    );
  }
  function cancelled() {
    return new Error("The community connection changed. Try again.");
  }
  function settled(source: Outbox, id: string) {
    return new Promise<Delivery | undefined>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (delivery?: Delivery, error?: Error) => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(delivery);
      };
      const abort = () => finish(undefined, cancelled());
      const inspect = () => {
        const item = source.snapshot().find((entry) => entry.event.id === id);
        // A verified echo marks a receipt-bound command seen while its
        // attempt still awaits the receipt; it leaves the journal afterward.
        if (item?.delivery !== "sending" && item?.delivery !== "seen")
          finish(item?.delivery);
      };
      unsubscribe = source.subscribe(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else inspect();
    });
  }
  function authorized(peer: string, id: string) {
    return new Promise<string>((resolve, reject) => {
      let unsubscribe = () => {};
      const done = (error?: Error) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(id);
      };
      const abort = () => done(cancelled());
      const timer = setTimeout(
        () =>
          done(
            new Error(
              "The conversation is open, but its membership is still loading. Try again.",
            ),
          ),
        rosterTimeoutMs,
      );
      const inspect = (reportError = true) => {
        const list = channels.list();
        if (reportError && list.status === "error")
          done(
            new Error(list.error ?? "Conversation membership could not load."),
          );
        else if (listed(peer, id)) done();
      };
      unsubscribe = channels.subscribeList(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      inspect(false); // An earlier roster error does not decide this attempt.
      channels.refreshList?.();
    });
  }
  /** Session change rejects promptly, even while journal work is still pending. */
  function scoped<T>(work: Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(cancelled());
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      work
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  /** Journal cleanup is best-effort; a retained intent is dismissed next open. */
  function discard(source: Outbox, id: string) {
    return scoped(source.dismiss(id).catch(() => {}));
  }
  async function run(source: Outbox, peer: string) {
    await scoped(ready);
    // A failed, unconfirmed or restored intent has no canonical ID. The relay
    // resolves a participant set to one DM, so a fresh command cannot duplicate it.
    for (const item of source.snapshot())
      if (peerOf(item.event) === peer) await discard(source, item.event.id);
    if (signal.aborted) throw cancelled();
    const id = source.send({
      kind: DM_OPEN_KIND,
      content: "",
      tags: [
        ["p", peer],
        ["d", crypto.randomUUID()],
      ],
    });
    const delivery = await settled(source, id);
    const channelId = receipts.get(id);
    receipts.delete(id);
    if (!channelId) {
      if (delivery === "failed") {
        await discard(source, id);
        throw new Error("The conversation could not be started. Try again.");
      }
      // Delivery may have succeeded; a retry's idempotent open resolves it.
      throw new Error("The conversation could not be confirmed. Try again.");
    }
    await discard(source, id);
    return authorized(peer, channelId);
  }
  return {
    capability: Object.freeze({
      available,
      /** Resolves to an authorized DM channel ID. Never an unverified request ID. */
      open(peer: string): Promise<string> {
        if (!key.test(peer) || peer === viewer)
          return Promise.reject(new Error("Choose another person to message."));
        if (!outbox || !available || signal.aborted)
          return Promise.reject(
            new Error("Direct messages are unavailable in this community."),
          );
        const current = opening.get(peer);
        if (current) return current;
        const attempt = run(outbox, peer).finally(() => opening.delete(peer));
        opening.set(peer, attempt);
        return attempt;
      },
    }),
    /** Outbox receipt hook. Receipt text is parsed, never journaled. */
    needsReceipt: (event: EventData) => !!peerOf(event),
    receipt(event: EventData, message: string | undefined) {
      receipts.delete(event.id);
      if (signal.aborted || !peerOf(event) || !message?.startsWith("response:"))
        return;
      try {
        const value: unknown = JSON.parse(message.slice("response:".length));
        const channelId =
          value && typeof value === "object" && "channel_id" in value
            ? value.channel_id
            : undefined;
        if (typeof channelId === "string" && uuid.test(channelId))
          receipts.set(event.id, channelId);
      } catch {
        /* Malformed receipt is unconfirmed, never a guessed destination. */
      }
    },
  };
}
