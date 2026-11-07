import { ByteLru, PROFILE_CACHE_BASE, PROFILE_ENTRY_BYTES } from "./budget";
import { newer, type RelayEvent } from "./events";
import {
  VERIFIED_PROFILE_BATCH,
  VERIFIED_PROFILE_MAX_SYNCS,
  verifiedProfile,
  verifiedProfileFilter,
  verifiedProfileSubject,
  type VerifiedProfileAuthority,
  type VerifiedProfile,
  type VerifiedProfileFilter,
  type VerifiedProfileSink,
} from "./verified-profile";

/** Batches allowed past the fewest that fit every wanted subject. */
const SPARE_BATCHES = 8;

/** One community/session owns this cache. No persistence across relay identities. */
export function createVerifiedProfileDirectory(
  initialAuthority: VerifiedProfileAuthority | undefined,
  subscribe: (
    filter: VerifiedProfileFilter,
    sink: VerifiedProfileSink,
  ) => (() => void) | undefined,
  changed: () => void,
  readDiscovery?: (
    signal: AbortSignal,
  ) => Promise<VerifiedProfileAuthority | null>,
) {
  let limit = PROFILE_CACHE_BASE;
  const heads = new ByteLru<RelayEvent>(limit, limit * PROFILE_ENTRY_BYTES);
  // Least recently ensured first.
  const wanted = new Set<string>();
  const checked = new Set<string>();
  // Subjects whose head changed since the owner last took them.
  const accepted = new Set<string>();
  type Batch = {
    stop(): void;
    subjects: readonly string[];
    /** A change accepted before EOSE that is not yet published. */
    pending(): boolean;
  };
  const batches = new Set<Batch>();
  /** A batch to keep, or subjects to start as a new one. */
  type Planned = {
    subjects: readonly string[];
    pending: boolean;
    batch?: Batch;
  };
  // Every profile publish projects every head: reuse the last projection of
  // an unchanged event so publishes skip revalidation and compare by identity.
  const projections = new WeakMap<
    RelayEvent,
    {
      authority: VerifiedProfileAuthority;
      checked: boolean;
      profile: VerifiedProfile | undefined;
    }
  >();
  let authority = initialAuthority;
  let enabled = !!authority;
  let discoveryFresh = !!authority;
  let discovery: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  let evicted = false;
  let closed = false;
  let online = true;

  function stopBatches() {
    for (const batch of batches) batch.stop();
    batches.clear();
    checked.clear();
  }
  function armRefresh() {
    clearTimeout(refreshTimer);
    if (readDiscovery && online && !closed && wanted.size)
      refreshTimer = setTimeout(() => void refresh(), 5 * 60_000);
  }
  async function refresh() {
    if (!readDiscovery || !online || closed || discovery) return;
    const request = new AbortController();
    discovery = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const next = await readDiscovery(request.signal);
      if (request.signal.aborted || discovery !== request || closed || !online)
        return;
      discoveryFresh = true;
      if (!next) {
        enabled = false;
        stopBatches();
      } else {
        if (authority?.pubkey !== next.pubkey) {
          stopBatches();
          heads.clear();
        }
        // An equal refresh keeps the current object, so unchanged heads keep
        // their projections. Re-enabling starts a new one: whatever was checked
        // under the withdrawn authority must be checked again.
        if (
          !enabled ||
          authority?.pubkey !== next.pubkey ||
          authority.multipleIssuers !== next.multipleIssuers ||
          authority.searchable !== next.searchable
        )
          authority = { ...next };
        enabled = true;
        schedule();
      }
    } catch {
      // Failed discovery is not an operator disable. Keep historical evidence,
      // but never present cached discovery as freshly checked.
      if (discovery === request) discoveryFresh = false;
    } finally {
      clearTimeout(timeout);
      if (discovery === request) {
        if (request.signal.aborted) discoveryFresh = false;
        discovery = undefined;
        armRefresh();
        changed();
      }
    }
  }

  function project(
    event: RelayEvent,
    currentAuthority: VerifiedProfileAuthority,
    isChecked: boolean,
  ) {
    const memo = projections.get(event);
    if (memo?.authority === currentAuthority && memo.checked === isChecked)
      return memo.profile;
    const profile = verifiedProfile(event, currentAuthority, isChecked);
    projections.set(event, {
      authority: currentAuthority,
      checked: isChecked,
      profile,
    });
    return profile;
  }

  /** Returns whether the head changed; the caller owns notification. */
  function accept(event: RelayEvent) {
    if (!authority || !enabled) return false;
    const subject = verifiedProfileSubject(event, authority);
    if (!subject || !wanted.has(subject)) return false;
    const old = heads.peek(subject);
    if (newer(old, event) === old) return false;
    heads.set(subject, event);
    accepted.add(subject);
    return true;
  }
  function start(
    currentAuthority: VerifiedProfileAuthority,
    chunk: readonly string[],
    // A change accepted before EOSE that is not yet published.
    dirty = false,
  ) {
    let active = true;
    let ready = false;
    const seen = new Set<string>();
    let count = 0;
    let stopWire: (() => void) | undefined;
    const batch: Batch = {
      subjects: chunk,
      pending: () => !ready && dirty,
      stop() {
        active = false;
        clearTimeout(timeout);
        stopWire?.();
      },
    };
    const fail = () => {
      if (!active) return;
      batch.stop();
      batches.delete(batch);
      for (const subject of chunk) checked.delete(subject);
      changed();
      // No hot retry loop. A later ensure or connection recovery restarts it.
    };
    const timeout = setTimeout(fail, 10_000);
    batches.add(batch);
    try {
      stopWire = subscribe(
        verifiedProfileFilter(currentAuthority.pubkey, chunk),
        {
          event(event) {
            if (!active) return;
            const subject = verifiedProfileSubject(event, currentAuthority);
            if (!subject || !chunk.includes(subject)) return;
            // Each notification refolds the whole profile directory, so a
            // replay notifies once at EOSE (or failure), not per event.
            if (!ready) {
              count++;
              seen.add(subject);
              if (accept(event)) dirty = true;
            } else if (accept(event)) changed();
          },
          eose() {
            if (!active) return;
            clearTimeout(timeout);
            ready = true;
            // A full response with missing subjects may be truncated. It is
            // never evidence that an omitted key has no current projection.
            const complete = count < chunk.length || seen.size === chunk.length;
            for (const subject of chunk) {
              const had = checked.has(subject);
              if (wanted.has(subject) && (seen.has(subject) || complete))
                checked.add(subject);
              // An incomplete replacement cannot confirm inherited status.
              else checked.delete(subject);
              if (had !== checked.has(subject)) dirty = true;
              if (complete && !seen.has(subject) && heads.peek(subject)) {
                heads.delete(subject);
                dirty = true;
              }
            }
            // A replay that confirmed what was already shown changes nothing.
            if (dirty) changed();
          },
          closed(reason) {
            if (!reason.startsWith("disconnected:")) return fail();
            // A replaced socket ends every sent sync. An outage then reports
            // the connection down in the same task, which stops every batch.
            // A planned renewal keeps it up: send the batch again and keep
            // its checked status until the replacement answers, as a rebuilt
            // batch does.
            queueMicrotask(() => {
              if (!active || !online) return fail();
              batch.stop();
              batches.delete(batch);
              start(currentAuthority, batch.subjects, batch.pending());
            });
          },
        },
      );
      if (!stopWire) fail();
      else if (!active) stopWire();
    } catch {
      fail();
    }
  }
  function schedule() {
    if (queued || closed || !online) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed || !online || !enabled || !authority) return;
      const currentAuthority = authority;
      // Membership is stable. New subjects start their own batch instead of
      // reissuing one the relay already answered, which would replay every
      // subject in it again. Evicted subjects leave membership but stay on
      // the wire until their batch is merged. A merged batch keeps checked
      // status until its replacement REQ responds; an incomplete response
      // clears it for omitted keys.
      const assigned = new Set<string>();
      const plan: Planned[] = [];
      for (const batch of batches) {
        for (const subject of batch.subjects) assigned.add(subject);
        if (batch.subjects.length)
          plan.push({
            subjects: batch.subjects,
            pending: batch.pending(),
            batch,
          });
      }
      const unassigned = [...wanted.keys()].filter(
        (subject) => !assigned.has(subject),
      );
      while (unassigned.length)
        plan.push({
          subjects: unassigned.splice(0, VERIFIED_PROFILE_BATCH),
          pending: false,
        });
      // Subscriptions stay near the fewest that fit every subject. Past the
      // budget, the smallest batches are packed together until half the spare
      // is free again, so the next arrivals get their own REQ instead of each
      // forcing a merge. Packing the smallest replays few subjects.
      const fewest = Math.ceil(wanted.size / VERIFIED_PROFILE_BATCH);
      const budget = Math.min(
        VERIFIED_PROFILE_MAX_SYNCS,
        fewest + SPARE_BATCHES,
      );
      const target =
        plan.length > budget
          ? Math.max(fewest, budget - SPARE_BATCHES / 2)
          : budget;
      while (plan.length > target) {
        plan.sort((x, y) => x.subjects.length - y.subjects.length);
        let size = 0;
        let count = 0;
        for (const item of plan) {
          size += item.subjects.length;
          count++;
          if (count > 1 && Math.ceil(size / VERIFIED_PROFILE_BATCH) < count)
            break;
        }
        const chunks = Math.ceil(size / VERIFIED_PROFILE_BATCH);
        // Unreachable: past `fewest`, the whole plan packs into fewer batches.
        if (chunks >= count) break;
        const group = plan.splice(0, count);
        const pending = group.some((item) => item.pending);
        const subjects = group.flatMap((item) => item.subjects);
        while (subjects.length)
          plan.push({
            subjects: subjects.splice(0, VERIFIED_PROFILE_BATCH),
            pending,
          });
      }
      // Stopping a batch frees its relay slot at once, so stop dropped batches
      // before starting new ones: the relay session refuses a sync past its
      // capacity, and a refused batch is not retried.
      const kept = new Set(plan.map((item) => item.batch));
      for (const batch of batches) {
        if (kept.has(batch)) continue;
        batch.stop();
        batches.delete(batch);
      }
      for (const item of plan)
        if (!item.batch) start(currentAuthority, item.subjects, item.pending);
      // Starting REQs changes no snapshot; only eviction removes names.
      if (evicted) {
        evicted = false;
        changed();
      }
    });
  }
  /** Drops the least recently ensured identities past the limit. */
  function trim() {
    const gone = new Set<string>();
    for (const oldest of wanted) {
      if (wanted.size - gone.size <= limit) break;
      gone.add(oldest);
    }
    forget(gone);
  }
  /** Evicted identities leave membership, so a later ensure asks again. */
  function forget(gone: ReadonlySet<string>) {
    if (!gone.size) return;
    for (const subject of gone) {
      wanted.delete(subject);
      heads.delete(subject);
      checked.delete(subject);
    }
    evicted = true;
    // A later ensure must issue a fresh REQ; the old one is past EOSE.
    for (const batch of batches)
      batch.subjects = batch.subjects.filter((key) => !gone.has(key));
  }
  return {
    ensure(subjects: readonly string[]) {
      if (closed) return;
      for (const subject of subjects) {
        if (!/^[0-9a-f]{64}$/.test(subject)) continue;
        wanted.delete(subject);
        wanted.add(subject);
      }
      trim();
      schedule();
      if (!refreshTimer && !discovery) armRefresh();
    },
    /** Follows the profile directory's limit; shrinking evicts and notifies now. */
    resize(next: number) {
      if (closed || next === limit) return;
      limit = next;
      // Request order decides who goes. After the trim every head is still
      // wanted, so the head budget can only evict for bytes.
      trim();
      const before = heads.keys();
      if (heads.resize(limit, limit * PROFILE_ENTRY_BYTES))
        forget(new Set(before.filter((subject) => !heads.peek(subject))));
      if (evicted) {
        evicted = false;
        changed();
      }
      // Stop the live syncs a shrink emptied now, not at the next ensure.
      schedule();
    },
    /** The current authority, or undefined while discovery disables marks. */
    authority: (): VerifiedProfileAuthority | undefined =>
      enabled ? authority : undefined,
    /** Whether a head is held for `subject`: its snapshot entry, or its absence
     * for an inactive or malformed head, is then the answer. */
    holds: (subject: string) => enabled && !!heads.peek(subject),
    /** Subjects whose head changed since the last call, held or since evicted. */
    takeAccepted() {
      const taken = [...accepted];
      accepted.clear();
      return taken;
    },
    snapshot(): ReadonlyMap<string, VerifiedProfile> {
      const currentAuthority = authority;
      if (!enabled || !currentAuthority) return new Map();
      return new Map(
        [...wanted.keys()].flatMap((subject) => {
          const event = heads.peek(subject);
          const profile =
            event &&
            project(
              event,
              currentAuthority,
              discoveryFresh && checked.has(subject),
            );
          return profile ? [[subject, profile] as const] : [];
        }),
      );
    },
    connected(value: boolean) {
      const wasOnline = online;
      online = value;
      if (!value) {
        stopBatches();
        if (readDiscovery) discoveryFresh = false;
        discovery?.abort();
        discovery = undefined;
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        changed();
      } else {
        schedule();
        if (!wasOnline) void refresh();
      }
    },
    clear() {
      stopBatches();
      discovery?.abort();
      discovery = undefined;
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      wanted.clear();
      heads.clear();
      changed();
    },
    dispose() {
      closed = true;
      this.clear();
    },
  };
}
