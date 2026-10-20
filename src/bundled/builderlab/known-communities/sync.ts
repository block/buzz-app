import {
  acknowledge,
  mergeList,
  type PendingOp,
  type SyncStatus,
} from "../../../features/communities/known-communities";
import type { KnownCommunities } from "../../../features/communities/service";
import type { OAuthSession } from "../oauth/session";
import type {
  KnownCommunitiesClient,
  ListResult,
  Refusal,
  UpdateResult,
} from "./client";

/** Why the service refused, in the viewer's terms. */
const REASONS: Record<Exclude<Refusal["kind"], "rejected">, string> = {
  invalid_request: "Builderlab refused one of your community addresses.",
  forbidden: "This Builderlab account can’t sync communities.",
  limit_reached: "Builderlab can’t save more communities for this account.",
  invalid_response: "Builderlab returned an invalid response.",
};
const reason = (refusal: Refusal) =>
  refusal.kind === "rejected"
    ? `Builderlab refused this request (HTTP ${refusal.status}).`
    : REASONS[refusal.kind];
const backoff = (failures: number) => Math.min(60_000, 1000 * 2 ** failures);
/** The service has no such route: not yet deployed, or only partly. */
const missing = (result: ListResult | UpdateResult) =>
  result.kind === "rejected" && result.status === 404;
/** An intent's identity for parking: the newer intent that replaces a parked
 * one is a different request and goes out. */
const key = (op: PendingOp) => `${op.removed ? "-" : "+"}${op.url}`;
const same = (a: SyncStatus | undefined, b: SyncStatus) =>
  a?.phase === b.phase && a.pending === b.pending && a.error === b.error;

/** Drains the known-community outbox to the account service and reconciles
 * its list, for one plugin lifetime. It runs only while signed in: each
 * sign-in merges the complete server list, then sends each destination's
 * latest intent one at a time. A newly queued intent, the window coming online
 * or becoming visible runs it again at once; a failure retries at 1·2·4… s,
 * capped at a minute, re-sending whatever intent then stands, which is safe
 * because the service's add and remove are idempotent. The service's refusals
 * are not retried: an account that cannot sync, or a list this client cannot
 * read, stops everything until the next sign-in, while a refused address, a
 * full account or another client error parks that one intent until it is
 * replaced or the next sign-in. A service without the routes (404 on any of
 * them) stops the same way but reports nothing to show. Signing out or
 * disposal abandons in-flight work and leaves the outbox intact. */
export function startKnownCommunitiesSync({
  client,
  session,
  knownCommunities,
}: {
  client: KnownCommunitiesClient;
  session: OAuthSession;
  knownCommunities: KnownCommunities;
}) {
  let disposed = false;
  // One per signed-in span; absent while signed out.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let running = false;
  let rerun = false;
  let listed = false;
  let halted = false;
  let unavailable = false;
  let error: string | undefined;
  let reported: SyncStatus | undefined;
  // Refused intents wait for the next sign-in, counted as pending meanwhile.
  const parked = new Set<string>();
  let outbox = knownCommunities.snapshot().sync.outbox;
  let ready = knownCommunities.snapshot().status === "ready";

  /** Reports a change of status; an unchanged one would only wake every
   * listener on the communities snapshot for nothing. */
  const publish = () => {
    if (disposed) return;
    const pending = knownCommunities.pending().length;
    const phase: SyncStatus["phase"] = !controller
      ? "signed-out"
      : unavailable
        ? "unavailable"
        : running
          ? "syncing"
          : error
            ? "error"
            : pending
              ? "pending"
              : "synced";
    const status: SyncStatus =
      phase === "error" && error
        ? { phase, pending, error }
        : { phase, pending };
    if (same(reported, status)) return;
    reported = status;
    knownCommunities.status(status);
  };
  const refuse = (refusal: Refusal) => {
    halted = true;
    if (missing(refusal)) unavailable = true;
    else error = reason(refusal);
  };
  async function run() {
    if (disposed || !controller || halted || running) return;
    const snapshot = knownCommunities.snapshot();
    // The store's listener runs this again once the identity is ready.
    if (snapshot.status !== "ready" || !snapshot.viewer) return;
    clearTimeout(timer);
    timer = undefined;
    const { signal } = controller;
    running = true;
    rerun = false;
    publish();
    try {
      if (!listed) {
        const list = await client.list(signal);
        if (list.kind !== "listed") return refuse(list);
        signal.throwIfAborted();
        if (list.dropped)
          console.warn(
            `Builderlab listed ${list.dropped} community address(es) this device can’t save; they were left out.`,
          );
        const current = knownCommunities.snapshot();
        const merged = mergeList(
          current.sync,
          current.memberships,
          list.communities,
        );
        await knownCommunities.apply(merged.state, {
          add: merged.add,
          remove: merged.remove,
        });
        listed = true;
      }
      for (;;) {
        const op = knownCommunities
          .pending()
          .find((entry) => !parked.has(key(entry)));
        if (!op) break;
        const result = op.removed
          ? await client.remove(op.url, signal)
          : await client.add(op.url, signal);
        signal.throwIfAborted();
        if (result.kind === "accepted")
          await knownCommunities.apply(
            acknowledge(knownCommunities.snapshot().sync, op),
          );
        else if (result.kind === "forbidden" || missing(result))
          return refuse(result);
        else {
          parked.add(key(op));
          error = reason(result);
        }
      }
      failures = 0;
      // A parked intent that was replaced or withdrawn no longer counts.
      const pending = knownCommunities.pending().map(key);
      for (const entry of parked)
        if (!pending.includes(entry)) parked.delete(entry);
      if (parked.size === 0) error = undefined;
    } catch (reason) {
      if (
        signal.aborted ||
        (reason instanceof Error && reason.name === "AbortError")
      )
        return;
      error =
        reason instanceof Error
          ? reason.message
          : "Couldn’t sync your community list.";
      timer = setTimeout(() => void run(), backoff(failures++));
    } finally {
      running = false;
      publish();
      if (rerun) void run();
    }
  }
  /** A trigger resets the backoff and runs now, or again once the request in
   * flight settles. Once the list has merged, nothing is waiting and no retry
   * is due, there is no pass to run. */
  const kick = () => {
    if (disposed || !controller || halted) return;
    if (listed && !timer && knownCommunities.pending().length === 0) return;
    failures = 0;
    clearTimeout(timer);
    timer = undefined;
    if (running) rerun = true;
    else void run();
  };
  const onSession = () => {
    const signedIn = session.snapshot().status === "signed-in";
    if (signedIn && !controller) {
      controller = new AbortController();
      listed = false;
      halted = false;
      unavailable = false;
      error = undefined;
      parked.clear();
      kick();
      // A run reports as it goes; a record still loading leaves none to run.
      if (!running) publish();
    } else if (!signedIn && controller) {
      controller.abort();
      controller = undefined;
      clearTimeout(timer);
      timer = undefined;
      publish();
    }
  };
  const onStore = () => {
    const snapshot = knownCommunities.snapshot();
    const wasReady = ready;
    ready = snapshot.status === "ready";
    if (snapshot.sync.outbox === outbox) {
      if (ready && !wasReady) kick();
      return;
    }
    const previous = outbox;
    outbox = snapshot.sync.outbox;
    // An intent this owner has not seen runs the drain at once; its own
    // acknowledgements only shrink the queue.
    const fresh = outbox.some((op) => !previous.includes(op));
    if (fresh || (ready && !wasReady)) kick();
    publish();
  };
  const online = () => kick();
  const visible = () => {
    if (document.visibilityState === "visible") kick();
  };
  const unsubscribeSession = session.subscribe(onSession);
  const unsubscribeStore = knownCommunities.subscribe(onStore);
  if (typeof window !== "undefined") window.addEventListener("online", online);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visible);
  onSession();
  publish();
  return () => {
    disposed = true;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    unsubscribeSession();
    unsubscribeStore();
    if (typeof window !== "undefined")
      window.removeEventListener("online", online);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", visible);
    knownCommunities.status(undefined);
  };
}
