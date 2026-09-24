import type { EventData } from "./events";

/** Largest lead over the local clock that send ordering may borrow. */
const MAX_LEAD_MS = 5000;

/** Sub-second send order: a valid `ms` tag within the signed second, else the second itself. */
export function eventMs(event: Pick<EventData, "created_at" | "tags">) {
  const value = event.tags.find(([name]) => name === "ms")?.[1];
  const ms = value && /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(ms) && Math.floor(ms / 1000) === event.created_at
    ? ms
    : event.created_at * 1000;
}

/** The one rendered message order: effective ms ascending, then event id ascending. */
export function compareMessages(
  a: Readonly<{ id: string; createdAt: number; createdAtMs?: number }>,
  b: Readonly<{ id: string; createdAt: number; createdAtMs?: number }>,
) {
  return (
    (a.createdAtMs ?? a.createdAt * 1000) -
      (b.createdAtMs ?? b.createdAt * 1000) || a.id.localeCompare(b.id)
  );
}

// Per-channel high-water marks for rendered messages, plus this device's last send.
const latest = new Map<string, number>();
let lastSent = 0;

/** Record rendered channel/thread evidence so the next send sorts after it. */
export function observeMessageMs(channelId: string, ms: number) {
  if (ms > (latest.get(channelId) ?? 0)) latest.set(channelId, ms);
}

/** Allocate a send time after everything known in the channel, bounded by the local clock. */
export function nextMessageMs(channelId: string, now = Date.now()) {
  const after = Math.max(latest.get(channelId) ?? 0, lastSent) + 1;
  const ms = after - now > MAX_LEAD_MS ? now : Math.max(now, after);
  lastSent = ms;
  observeMessageMs(channelId, ms);
  return ms;
}
