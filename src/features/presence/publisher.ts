import type { PresenceActivity } from "./activity";
export type PresencePublisherLock = (
  signal: AbortSignal,
  work: () => Promise<void>,
) => Promise<void>;
export function browserPresencePublisherLock(
  scope: string,
): PresencePublisherLock | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  return (signal, work) =>
    navigator.locks.request(
      `buzz-presence:${scope}`,
      { mode: "exclusive", signal },
      work,
    );
}
/** A renewable, lossy signal; exactly one in-flight operation, never a durable queue. */
export function createPresencePublisher({
  activity,
  publish,
  lock,
  random = Math.random,
}: {
  activity: PresenceActivity;
  publish(status: "online" | "away", signal: AbortSignal): Promise<void>;
  lock?: PresencePublisherLock | undefined;
  random?: () => number;
}) {
  let closed = false;
  let connected = false;
  let owner: AbortController | undefined;
  let leader = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let desired = activity.snapshot().status;
  let lastStart = -Infinity;
  let due = 0;
  const counters = { attempts: 0, accepted: 0, failures: 0 };
  let error: string | undefined;
  function schedule() {
    if (closed || !connected || !leader || running || timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void send();
      },
      Math.max(0, due - Date.now(), lastStart + 1000 - Date.now()),
    );
  }
  async function send() {
    const current = owner;
    if (
      !current ||
      current.signal.aborted ||
      !leader ||
      !connected ||
      closed ||
      running
    )
      return;
    const status = desired;
    lastStart = Date.now();
    running = true;
    counters.attempts++;
    try {
      await publish(
        status,
        AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
      );
      if (owner !== current || current.signal.aborted) return;
      counters.accepted++;
      error = undefined;
    } catch (failure) {
      if (owner !== current || current.signal.aborted) return;
      counters.failures++;
      error =
        failure instanceof Error
          ? failure.message
          : "Presence publication unavailable";
    } finally {
      // A retired generation must not control a newer publisher's in-flight state.
      if (owner === current) {
        running = false;
        due =
          Date.now() + (status === desired ? 60000 + random() * 5000 : 1000);
        schedule();
      }
    }
  }
  function stop() {
    owner?.abort();
    owner = undefined;
    leader = running = false;
    clearTimeout(timer);
    timer = undefined;
  }
  function start() {
    if (closed || !connected || owner) return;
    const owned = new AbortController();
    owner = owned;
    const work = async () => {
      if (closed || owned.signal.aborted || owner !== owned) return;
      leader = true;
      desired = activity.snapshot().status;
      due = Date.now() + 250 + random() * 750; // Startup/reconnect yields and spreads scopes.
      schedule();
      await new Promise<void>((resolve) =>
        owned.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    void (lock ? lock(owned.signal, work) : work()).catch(
      (failure: unknown) => {
        if (owned.signal.aborted || owner !== owned) return;
        error =
          failure instanceof Error
            ? failure.message
            : "Presence ownership unavailable";
        stop(); // No unlocked fallback that would silently create duplicate publishers.
      },
    );
  }
  const unsubscribe = activity.subscribe(() => {
    const next = activity.snapshot().status;
    if (desired === next) return;
    desired = next;
    due = Date.now();
    clearTimeout(timer);
    timer = undefined;
    schedule();
  });
  return {
    connection(active: boolean) {
      if (closed || connected === active) return;
      connected = active;
      if (active) start();
      else stop();
    },
    dispose() {
      closed = true;
      stop();
      unsubscribe();
    },
    diagnostics: () => ({
      ...counters,
      leader,
      coordinated: !!lock,
      running,
      error,
    }),
  };
}
