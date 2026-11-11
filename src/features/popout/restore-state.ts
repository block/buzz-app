import { readView, writeView } from "../../shared/view-state";

/** Physical outer position and client size, as native reports them. */
export type PopoutGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** One window to reopen: its binding target, the thread a conversation
 * window drilled into (so Back survives), and where it was on screen. */
export type PopoutDescriptor = {
  channelId: string;
  threadRootId?: string | undefined;
  frameRootId?: string | undefined;
  geometry?: PopoutGeometry | undefined;
};

const KEY = "popouts";
const VERSION = 1;
/** Native refuses more windows than this. */
export const MAX_RESTORED = 16;
const hex = /^[0-9a-f]{64}$/;
const COORDINATE_LIMIT = 1 << 24;

const sameTarget = (a: PopoutDescriptor, b: PopoutDescriptor) =>
  a.channelId === b.channelId && a.threadRootId === b.threadRootId;

export function validGeometry(value: unknown): value is PopoutGeometry {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  const whole = (n: unknown, min: number) =>
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= min &&
    n <= COORDINATE_LIMIT;
  return (
    whole(g.x, -COORDINATE_LIMIT) &&
    whole(g.y, -COORDINATE_LIMIT) &&
    whole(g.width, 1) &&
    whole(g.height, 1)
  );
}

function validDescriptor(value: unknown): value is PopoutDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  const id = (v: unknown) =>
    v === undefined || (typeof v === "string" && hex.test(v));
  return (
    typeof d.channelId === "string" &&
    d.channelId.length > 0 &&
    d.channelId.length <= 256 &&
    id(d.threadRootId) &&
    id(d.frameRootId) &&
    // Only a conversation window has a drilled frame.
    !(d.threadRootId && d.frameRootId) &&
    (d.geometry === undefined || validGeometry(d.geometry))
  );
}

/** The saved list for one `origin:viewer` partition; corrupt or oversized
 * storage reads as empty so manual opening stays usable. */
export function readPopoutDescriptors(scope: string): PopoutDescriptor[] {
  const stored = readView<unknown>(scope, KEY, null);
  if (!stored || typeof stored !== "object") return [];
  const { v, windows } = stored as { v?: unknown; windows?: unknown };
  if (v !== VERSION || !Array.isArray(windows)) return [];
  const seen: PopoutDescriptor[] = [];
  for (const item of windows) {
    if (!validDescriptor(item) || seen.some((d) => sameTarget(d, item)))
      continue;
    seen.push({
      channelId: item.channelId,
      ...(item.threadRootId ? { threadRootId: item.threadRootId } : {}),
      ...(item.frameRootId ? { frameRootId: item.frameRootId } : {}),
      ...(item.geometry ? { geometry: item.geometry } : {}),
    });
    if (seen.length >= MAX_RESTORED) break;
  }
  return seen;
}

export function writePopoutDescriptors(
  scope: string,
  windows: readonly PopoutDescriptor[],
) {
  return writeView(scope, KEY, {
    v: VERSION,
    windows: windows.slice(0, MAX_RESTORED),
  });
}

/** The durable list of one partition, mutated by target and written through
 * on every change. It is never derived from live windows, so a window not yet
 * reopened by a restore batch stays saved while others open. */
export function createPopoutDescriptors(scope: string) {
  let windows = readPopoutDescriptors(scope);
  const write = () => writePopoutDescriptors(scope, windows);
  const find = (target: PopoutDescriptor) =>
    windows.find((d) => sameTarget(d, target));
  return {
    snapshot: () => windows,
    /** The current entry for a target, if it is still saved. */
    find,
    /** Add or replace the entry for a target, keeping its order when known. */
    upsert(descriptor: PopoutDescriptor) {
      const existing = find(descriptor);
      if (existing) {
        windows = windows.map((d) => (d === existing ? descriptor : d));
      } else {
        if (windows.length >= MAX_RESTORED) return;
        windows = [...windows, descriptor];
      }
      write();
    },
    patch(
      target: PopoutDescriptor,
      change: Pick<Partial<PopoutDescriptor>, "frameRootId" | "geometry">,
    ) {
      const existing = find(target);
      if (!existing) return;
      const next = { ...existing };
      if ("frameRootId" in change) {
        if (change.frameRootId) next.frameRootId = change.frameRootId;
        else delete next.frameRootId;
      }
      if ("geometry" in change) {
        if (change.geometry) next.geometry = change.geometry;
        else delete next.geometry;
      }
      windows = windows.map((d) => (d === existing ? next : d));
      write();
    },
    forget(target: PopoutDescriptor) {
      if (!find(target)) return;
      windows = windows.filter((d) => !sameTarget(d, target));
      write();
    },
  };
}
export type PopoutDescriptors = ReturnType<typeof createPopoutDescriptors>;
