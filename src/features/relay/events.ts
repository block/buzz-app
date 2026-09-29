import {
  getEventHash,
  verifyEvent,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";
import { clientMetrics } from "../developer/client-metrics.ts";
import { ByteLru } from "./budget.ts";
import { checkSignatures } from "./signature-pool.ts";
import { yieldToHost } from "./yield.ts";
/** A relay event whose signature has been verified at the transport boundary. */
export type RelayEvent = VerifiedEvent;
/** Event payload shared by locally authored intent and verified relay records.
 * Only RelayEvent carries signature verification; local intent never establishes relay authority. */
export type EventData = Readonly<
  Pick<RelayEvent, "id" | "pubkey" | "created_at" | "kind" | "content" | "tags">
>;
export type ReadFilter = Readonly<{
  kinds?: readonly number[];
  ids?: readonly string[];
  /** NIP-01 single-letter tag filters, including references (#e/#a) and topics (#t). */
  [tag: `#${string}`]: readonly string[] | undefined;
  limit: number;
  authors?: readonly string[];
  /** Read from the writer when resolving uncertain publication or admission. */
  consistency?: "strong";
  until?: number;
  since?: number;
  "#h"?: readonly string[];
  "#d"?: readonly string[];
  "#p"?: readonly string[];
  /** Buzz relay extensions for channel history windows. */
  top_level?: boolean;
  include_aux?: boolean;
  include_summaries?: boolean;
  before_id?: string;
  /** HTTP bridge finite search, home-feed, and thread traversal extensions. */
  search?: string;
  search_mode?: "prefix" | "fulltext";
  page?: number;
  feed_types?: readonly string[];
  depth_limit?: number;
  thread_cursor?: number;
  thread_cursor_id?: string;
}>;
export function eventDto(value: unknown): RelayEvent {
  return checkedEvent(value, verifyEvent);
}

/** One HTTP connection's bounded proof memo, not an event/result cache. Only a
 * matching content hash AND exact signature can reuse a successful verification.
 * Retains no payload, authorization, freshness or caller-supplied proof symbols. */
export function createEventVerifier() {
  const proofs = new ByteLru<string>(2048, 2048 * 192);
  const proven = (event: Event) =>
    proofs.get(event.id) === event.sig && getEventHash(event) === event.id;
  const remember = (event: Event) => proofs.set(event.id, event.sig, 192); // fixed ASCII id (64) + signature (128)
  const verify = (value: unknown): RelayEvent =>
    checkedEvent(value, (event): event is VerifiedEvent => {
      if (proven(event)) return true;
      if (!verifyEvent(event)) return false;
      remember(event);
      return true;
    });
  /** Bulk reads: validate and copy wire fields here, check new signatures on a
   * worker so they never compete with input and rendering. Reads within one
   * inline batch skip the round-trip, keeping small startup reads (rosters,
   * presence) in their inline order. One bad signature rejects the whole batch,
   * as the single-event path does. */
  async function many(
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<RelayEvent[]> {
    const cancelled = () => {
      if (signal?.aborted)
        throw new DOMException("Read cancelled", "AbortError");
    };
    const owned: Event[] = [];
    const fresh: Event[] = [];
    await inBatches(values.length, cancelled, (index) => {
      const event = wireFields(values[index]);
      owned.push(event);
      if (!proven(event)) fresh.push(event);
    });
    clientMetrics.cpu("verify.read", 0, owned.length);
    clientMetrics.cpu("verify.reused", 0, owned.length - fresh.length);
    const worker =
      fresh.length > BATCH ? await checkSignatures(fresh, signal) : undefined;
    cancelled();
    if (worker) {
      clientMetrics.cpu("verify.worker", worker.ms, fresh.length);
      if (!worker.ok) throw invalidEvent();
      for (const event of fresh) remember(event);
    } else {
      // Small read, or no worker (tests, or it failed to load): check inline
      // between yields.
      await inBatches(fresh.length, cancelled, (index) => {
        const event = fresh[index] as Event;
        if (!verifyEvent(event)) throw invalidEvent();
        remember(event);
      });
    }
    const result: RelayEvent[] = [];
    await inBatches(owned.length, cancelled, (index) =>
      result.push(sealed(owned[index] as Event)),
    );
    return result;
  }
  return Object.assign(verify, { many });
}
export type EventVerifier = ReturnType<typeof createEventVerifier>;

const BATCH = 12;
/** Main-thread work over a bulk read, in bounded batches that yield to input
 * and rendering and stop at the next boundary once the read is cancelled. */
async function inBatches(
  length: number,
  cancelled: () => void,
  step: (index: number) => void,
) {
  for (let index = 0; index < length; index += BATCH) {
    cancelled();
    const started = performance.now();
    for (let item = index; item < Math.min(length, index + BATCH); item++)
      step(item);
    clientMetrics.cpu("verify.read", performance.now() - started, 0);
    if (index + BATCH < length) await yieldToHost();
  }
}

/** Disk restore of events this app saved only after verifying them. Rehashing
 * catches corruption and any edit to signed fields; the Schnorr check is skipped.
 * The store is origin-private IndexedDB that only this app writes, so anything
 * able to forge a record there can already run code as the app. */
export function savedEvent(value: unknown): RelayEvent {
  return checkedEvent(
    value,
    (event): event is VerifiedEvent => getEventHash(event) === event.id,
  );
}

const invalidEvent = () =>
  new Error("Relay supplied a malformed or invalidly signed event");

function checkedEvent(
  value: unknown,
  verify: (event: Event) => event is VerifiedEvent,
): RelayEvent {
  const owned = wireFields(value);
  if (!verify(owned)) throw invalidEvent();
  return sealed(owned);
}

function wireFields(value: unknown): Event {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidEvent();
  const raw = value as Record<string, unknown>;
  // nostr-tools validates only typeof number here. JSON overflow becomes Infinity
  // and hashes as null; fractions/unsafe integers cannot be protocol timestamps.
  if (
    typeof raw.created_at !== "number" ||
    !Number.isSafeInteger(raw.created_at) ||
    raw.created_at < 0 ||
    typeof raw.kind !== "number" ||
    !Number.isInteger(raw.kind) ||
    raw.kind < 0 ||
    raw.kind > 65535 ||
    typeof raw.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.id) ||
    typeof raw.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.pubkey) ||
    typeof raw.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(raw.sig) ||
    typeof raw.content !== "string" ||
    !Array.isArray(raw.tags) ||
    raw.tags.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((item) => typeof item !== "string"),
    )
  )
    throw invalidEvent();
  // Copy only wire fields before verification. Never trust a cached verification
  // symbol from a caller-owned object whose signed bytes may have changed.
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    sig: raw.sig,
    created_at: raw.created_at,
    kind: raw.kind,
    content: raw.content,
    tags: raw.tags.map((tag: string[]) => [...tag]),
  };
}

/** Freeze a copy whose signature has been accepted by the caller. */
function sealed(owned: Event): RelayEvent {
  for (const tag of owned.tags) Object.freeze(tag);
  Object.freeze(owned.tags);
  return Object.freeze(
    Object.assign(owned, { [verifiedSymbol]: true as const }),
  );
}

export const tag = (event: RelayEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
export const hasTag = (event: RelayEvent, name: string, value: string) =>
  event.tags.some((entry) => entry[0] === name && entry[1] === value);

/** Later created_at wins; ties break on lower id so replay order cannot flip the result. */
export function newer<T extends EventData>(
  current: T | undefined,
  candidate: T,
): T {
  return !current ||
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
    ? candidate
    : current;
}
