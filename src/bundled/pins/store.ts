import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  PIN_KIND,
  PIN_REMOVAL_KIND,
  foldPins,
  pinWrite,
  unpinWrite,
  type Pin,
} from "../../features/pins/protocol";

/** Pins the relay holds for a channel, newest first. */
const PAGE = 200;

export type PinsState = Readonly<{
  status: "loading" | "ready" | "failed";
  pins: readonly Pin[];
  /** Message id → pin, for row markers and the menu item. */
  byMessage: ReadonlyMap<string, Pin>;
}>;
export type ChannelPins = Readonly<{
  subscribe(listener: () => void): () => void;
  snapshot(): PinsState;
  /** Publish a pin; it shows at once and drops if the relay refuses it. */
  pin(messageId: string): void;
  unpin(pin: Pin): void;
  retry(): void;
}>;

const relevant = (event: EventData) =>
  event.kind === PIN_KIND ||
  event.kind === 5 ||
  event.kind === PIN_REMOVAL_KIND;

function createChannelPins(
  session: RelaySession,
  channelId: string,
): ChannelPins {
  const listeners = new Set<() => void>();
  let fetched: readonly EventData[] = [];
  let live: EventData[] = [];
  let status: PinsState["status"] = "loading";
  let state: PinsState | undefined;
  let started = false;
  let generation = 0;

  const pending = () =>
    (session.outbox?.snapshot() ?? [])
      .filter(
        (item) =>
          item.delivery !== "failed" &&
          !item.refused &&
          relevant(item.event) &&
          item.event.tags.some(
            ([name, id]) => name === "h" && id === channelId,
          ),
      )
      .map((item) => item.event);
  const changed = () => {
    state = undefined;
    for (const listener of [...listeners]) listener();
  };
  const load = () => {
    const current = ++generation;
    status = "loading";
    changed();
    session.read([{ kinds: [PIN_KIND], "#h": [channelId], limit: PAGE }]).then(
      (events) => {
        if (current !== generation) return;
        fetched = events;
        status = "ready";
        changed();
      },
      () => {
        if (current !== generation) return;
        status = "failed";
        changed();
      },
    );
  };
  const start = () => {
    if (started) return;
    started = true;
    // Kind 5 carries no channel on some clients; keep removals naming a pin.
    session.subscribeLive(({ events }) => {
      const arrivals = events.filter(
        (event) =>
          relevant(event) &&
          (event.kind !== PIN_KIND ||
            event.tags.some(([name, id]) => name === "h" && id === channelId)),
      );
      if (!arrivals.length) return;
      live = [...live, ...arrivals].slice(-PAGE);
      changed();
    });
    session.outbox?.subscribe(changed);
    load();
  };

  return {
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      if (state) return state;
      const pins = foldPins([...fetched, ...live, ...pending()], channelId);
      state = Object.freeze({
        status,
        pins,
        byMessage: new Map(pins.map((pin) => [pin.messageId, pin])),
      });
      return state;
    },
    pin(messageId) {
      if (!session.outbox) throw new Error("Pins are unavailable here.");
      session.outbox.send(pinWrite(channelId, messageId));
    },
    unpin(pin) {
      const viewer = session.viewer;
      if (!session.outbox || !viewer)
        throw new Error("Pins are unavailable here.");
      session.outbox.send(unpinWrite(pin, viewer));
    },
    retry: load,
  };
}

const stores = new WeakMap<RelaySession, Map<string, ChannelPins>>();

/** One shared store per session and channel, so the panel, menu items and
 * row markers agree; it lives as long as the session. */
export function channelPins(session: RelaySession, channelId: string) {
  let channels = stores.get(session);
  if (!channels) {
    channels = new Map();
    stores.set(session, channels);
  }
  let store = channels.get(channelId);
  if (!store) {
    store = createChannelPins(session, channelId);
    channels.set(channelId, store);
  }
  return store;
}

/** Whether this session can write pins at all; per-channel role is checked
 * separately and the relay has the final say. */
export function pinsSupported(session: RelaySession) {
  const outbox = session.outbox;
  return (
    !!session.viewer &&
    !!outbox &&
    outbox.supports(PIN_KIND) &&
    outbox.supports(5) &&
    outbox.supports(PIN_REMOVAL_KIND)
  );
}
