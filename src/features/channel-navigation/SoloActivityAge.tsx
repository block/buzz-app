import { useCallback, useSyncExternalStore } from "react";

type AgeSource = "activity" | "updated";

type AgeListeners = {
  timestamp: number;
  source: AgeSource;
  snapshot: string | undefined;
  listeners: Set<() => void>;
};

const listeners = new Map<string, AgeListeners>();
let timer: number | undefined;
const maxTimerDelay = 2_147_483_647;

export function soloActivityDateTime(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp === 0) return undefined;
  const milliseconds = timestamp * 1000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15)
    return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function soloActivityAgeId(channelId: string) {
  return `solo-activity-age-${channelId}`;
}

function snapshot(timestamp: number, source: AgeSource, now: number) {
  if (!soloActivityDateTime(timestamp)) return undefined;
  const seconds = Math.max(0, Math.floor(now / 1000) - timestamp);
  let compact: string;
  let spoken: string;
  if (seconds < 60) {
    compact = "now";
    spoken = "just now";
  } else if (seconds < 3600) {
    const value = Math.floor(seconds / 60);
    compact = `${value}m`;
    spoken = `${value} minute${value === 1 ? "" : "s"} ago`;
  } else if (seconds < 86400) {
    const value = Math.floor(seconds / 3600);
    compact = `${value}h`;
    spoken = `${value} hour${value === 1 ? "" : "s"} ago`;
  } else {
    const value = Math.floor(seconds / 86400);
    compact = `${value}d`;
    spoken = `${value} day${value === 1 ? "" : "s"} ago`;
  }
  return `${compact}\0${source === "activity" ? "Active" : "Updated"} ${spoken}`;
}

function nextRefresh(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor(now / 1000) - timestamp);
  const boundary =
    seconds < 60
      ? 60
      : seconds < 3600
        ? (Math.floor(seconds / 60) + 1) * 60
        : seconds < 86400
          ? (Math.floor(seconds / 3600) + 1) * 3600
          : (Math.floor(seconds / 86400) + 1) * 86400;
  return Math.max(1, Math.ceil((timestamp + boundary) * 1000) - now);
}

function refresh() {
  const now = Date.now();
  for (const entry of listeners.values()) {
    const next = snapshot(entry.timestamp, entry.source, now);
    if (next === entry.snapshot) continue;
    entry.snapshot = next;
    for (const listener of entry.listeners) listener();
  }
  schedule();
}

function currentSnapshot(timestamp: number, source: AgeSource) {
  return (
    listeners.get(`${source}:${timestamp}`)?.snapshot ??
    snapshot(timestamp, source, Date.now())
  );
}

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!listeners.size) return;
  const now = Date.now();
  const delay = Math.min(
    ...[...listeners.values()].map((entry) =>
      nextRefresh(entry.timestamp, now),
    ),
  );
  timer = window.setTimeout(refresh, Math.min(delay, maxTimerDelay));
}

function subscribe(timestamp: number, source: AgeSource, listener: () => void) {
  const key = `${source}:${timestamp}`;
  let entry = listeners.get(key);
  if (!entry) {
    entry = {
      timestamp,
      source,
      snapshot: snapshot(timestamp, source, Date.now()),
      listeners: new Set(),
    };
    listeners.set(key, entry);
  }
  entry.listeners.add(listener);
  if (listeners.size === 1 && entry.listeners.size === 1) {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  schedule();
  return () => {
    entry?.listeners.delete(listener);
    if (entry && !entry.listeners.size) listeners.delete(key);
    if (!listeners.size) {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    } else {
      schedule();
    }
  };
}

export function SoloActivityAge({
  timestamp,
  source,
  descriptionId,
}: {
  timestamp: number;
  source: AgeSource;
  descriptionId: string;
}) {
  const iso = soloActivityDateTime(timestamp);
  const listen = useCallback(
    (listener: () => void) =>
      iso ? subscribe(timestamp, source, listener) : () => {},
    [iso, source, timestamp],
  );
  const read = useCallback(
    () => (iso ? currentSnapshot(timestamp, source) : undefined),
    [iso, source, timestamp],
  );
  const value = useSyncExternalStore(listen, read, read);
  if (!iso || !value) return null;
  const split = value.indexOf("\0");
  return (
    <>
      <time dateTime={iso} aria-hidden="true">
        {value.slice(0, split)}
      </time>
      <span id={descriptionId} hidden>
        {value.slice(split + 1)}
      </span>
    </>
  );
}
