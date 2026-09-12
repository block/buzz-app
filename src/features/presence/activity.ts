export type ActivitySnapshot = Readonly<{
  status: "online" | "away";
  visible: boolean;
}>;
export type PresenceActivity = {
  snapshot(): ActivitySnapshot;
  subscribe(listener: () => void): () => void;
};
const IDLE_MS = 10 * 60 * 1000;
/** One app-owned detector. Web fallback measures Buzz input, not machine-wide idle.
 * Same-origin windows exchange activity only; no identity, message or status history. */
export function createPresenceActivity() {
  let closed = false;
  let lastInput = Date.now();
  let lastBroadcast = 0;
  const doc = typeof document === "undefined" ? undefined : document;
  const page = typeof window === "undefined" ? undefined : window;
  let state: ActivitySnapshot = Object.freeze({
    status: "online",
    visible: doc?.visibilityState !== "hidden",
  });
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | undefined;
  try {
    if (page && typeof BroadcastChannel !== "undefined")
      channel = new BroadcastChannel("buzz-presence-activity-v1");
  } catch {
    /* Local input remains usable when cross-window messaging is unavailable. */
  }
  function sample() {
    if (closed) return;
    const status = Date.now() - lastInput >= IDLE_MS ? "away" : "online";
    const visible = doc?.visibilityState !== "hidden";
    if (status === state.status && visible === state.visible) return;
    state = Object.freeze({ status, visible });
    for (const listener of listeners) listener();
  }
  function input() {
    const now = Date.now();
    if (closed || doc?.visibilityState === "hidden") return;
    // Raw activity remains local, outside React; network publication observes derived state only.
    lastInput = now;
    if (now - lastBroadcast >= 1000) {
      lastBroadcast = now;
      channel?.postMessage(now);
      sample();
    }
  }
  if (channel)
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      const now = Date.now();
      if (
        typeof data !== "number" ||
        !Number.isSafeInteger(data) ||
        data > now + 1000 ||
        data < now - IDLE_MS
      )
        return;
      lastInput = Math.max(lastInput, Math.min(data, now));
      sample();
    };
  const events = ["pointerdown", "pointermove", "keydown", "wheel"];
  for (const event of events)
    doc?.addEventListener(event, input, { passive: true });
  doc?.addEventListener("visibilitychange", sample);
  page?.addEventListener("pageshow", sample);
  const timer = setInterval(sample, 30000);
  return {
    activity: {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies PresenceActivity,
    dispose() {
      closed = true;
      clearInterval(timer);
      channel?.close();
      listeners.clear();
      for (const event of events) doc?.removeEventListener(event, input);
      doc?.removeEventListener("visibilitychange", sample);
      page?.removeEventListener("pageshow", sample);
    },
  };
}
