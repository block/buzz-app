import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools";
import type { ReadFilter, RelayEvent } from "./events";
import type { ReadTransport } from "./transport";

/** Test-only signing helpers. Real signatures so the transport's verification stays on. */
export function keypair() {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}
export type Key = ReturnType<typeof keypair>;
export function signed(
  key: Key,
  template: Omit<EventTemplate, "created_at"> & { created_at?: number },
): RelayEvent {
  return finalizeEvent({ created_at: 1_700_000_000, ...template }, key.secret);
}
export function message(
  key: Key,
  channelId: string,
  content: string,
  created_at: number,
  extraTags: string[][] = [],
): RelayEvent {
  return signed(key, {
    kind: 9,
    content,
    created_at,
    tags: [["h", channelId], ...extraTags],
  });
}
export function bounds(
  relay: Key,
  channelId: string,
  cursorSuffix: string,
  body: {
    has_more: boolean;
    next_cursor: { created_at: number; id: string } | null;
  },
): RelayEvent {
  return signed(relay, {
    kind: 39006,
    content: JSON.stringify(body),
    tags: [
      ["h", channelId],
      ["d", `${channelId}:${cursorSuffix}`],
    ],
  });
}
export function summary(
  relay: Key,
  channelId: string,
  rowId: string,
  body: Record<string, unknown>,
): RelayEvent {
  return signed(relay, {
    kind: 39005,
    content: JSON.stringify(body),
    tags: [
      ["e", rowId],
      ["d", rowId],
      ["h", channelId],
    ],
  });
}
export function roster(
  relay: Key,
  channelId: string,
  members: readonly string[],
  created_at = 1_700_000_000,
): RelayEvent {
  return signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [["d", channelId], ...members.map((member) => ["p", member])],
  });
}
export function metadata(
  relay: Key,
  channelId: string,
  name: string,
  created_at = 1_700_000_000,
): RelayEvent {
  return signed(relay, {
    kind: 39000,
    content: JSON.stringify({ name }),
    created_at,
    tags: [
      ["d", channelId],
      ["name", name],
    ],
  });
}
export function profile(
  key: Key,
  body: Record<string, unknown>,
  created_at = 1_700_000_000,
): RelayEvent {
  return signed(key, {
    kind: 0,
    content: JSON.stringify(body),
    created_at,
    tags: [],
  });
}

export type Scripted = {
  filters: readonly ReadFilter[];
  respond: (events: RelayEvent[]) => void;
  fail: (error: unknown) => void;
  signal: AbortSignal | undefined;
};
/** A transport whose responses the test releases explicitly, so ordering and cancellation are observable. */
export function scriptedTransport(viewer: string, relayAuthor: string) {
  const pending: Scripted[] = [];
  const transport: ReadTransport = {
    viewer,
    relayAuthor,
    media: (url) => (/^https:\/\//.test(url) ? url : undefined),
    query(filters, signal) {
      return new Promise<RelayEvent[]>((resolve, reject) => {
        const entry: Scripted = {
          filters,
          respond: resolve,
          fail: reject,
          signal,
        };
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
        pending.push(entry);
      });
    },
  };
  return {
    transport,
    pending,
    next: () => {
      const entry = pending.shift();
      if (!entry) throw new Error("No pending query");
      return entry;
    },
  };
}
export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
