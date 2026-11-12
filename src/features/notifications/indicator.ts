import { invoke, isTauri } from "@tauri-apps/api/core";

export type IndicatorPermission =
  | "default"
  | "setup"
  | "enabled"
  | "disabled"
  | "denied"
  | "unavailable";
export interface IndicatorPlatform {
  permission(request: boolean): Promise<IndicatorPermission>;
  set(unread: boolean, count?: number): Promise<void>;
}
type Badge = Readonly<{ unread: boolean; count: number }>;
const sameBadge = (left: Badge | undefined, right: Badge) =>
  left?.unread === right.unread && left.count === right.count;
export function indicatorPlatform(): IndicatorPlatform | undefined {
  const os = globalThis.navigator?.platform ?? "";
  if (!isTauri() || !/Mac/i.test(os)) return;
  return {
    permission: (request) => invoke("dock_permission", { request }),
    set: (unread, count) =>
      invoke("unread_indicator_set", { unread, ...(count ? { count } : {}) }),
  };
}

/** One ordered native projection. Pending work always converges on current intent. */
export function createUnreadIndicator(
  platform = indicatorPlatform(),
  host:
    | Pick<Window, "addEventListener" | "removeEventListener">
    | undefined = typeof window === "undefined" ? undefined : window,
) {
  let closed = false,
    unread = false;
  let count = 0;
  let state = Object.freeze({
    permission: "unavailable" as IndicatorPermission,
    requesting: false as boolean,
    error: null as string | null,
  });
  const listeners = new Set<() => void>();
  let desired: Badge = { unread: false, count: 0 };
  let applied: Badge | undefined;
  let writing: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  const publish = (patch: Partial<typeof state>) => {
    if (closed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const failed = (error: unknown) =>
    publish({ error: error instanceof Error ? error.message : String(error) });
  function project() {
    const enabled = !closed && unread && state.permission === "enabled";
    desired = { unread: enabled, count: enabled ? count : 0 };
    if (!platform || writing || sameBadge(applied, desired)) return;
    let attempted = desired;
    writing = (async () => {
      while (!sameBadge(applied, desired)) {
        const next = desired;
        attempted = next;
        try {
          if (next.count > 0) await platform.set(next.unread, next.count);
          else await platform.set(next.unread);
          applied = next;
        } catch (error) {
          failed(error);
          // No retry loop. A later user action or unread transition can retry.
          if (sameBadge(desired, next)) break;
        }
      }
    })().finally(() => {
      writing = undefined;
      if (!sameBadge(desired, attempted)) project();
    });
  }
  function check(request: boolean): Promise<void> {
    if (closed || !platform) return Promise.resolve();
    if (checking) {
      return request && !state.requesting
        ? checking.then(() => check(true))
        : checking;
    }
    publish({ requesting: request, error: null });
    checking = Promise.resolve()
      .then(() => platform.permission(request))
      .then((permission) => {
        publish({ permission });
      })
      .catch((error: unknown) => {
        publish({ permission: "unavailable" });
        failed(error);
      })
      .finally(() => {
        checking = undefined;
        publish({ requesting: false });
        project();
      });
    return checking;
  }
  const refresh = () => {
    void check(false);
  };
  project(); // Clear an earlier frontend's unread state before observing any new state.
  if (platform) {
    host?.addEventListener("focus", refresh);
    refresh();
  }
  return {
    available: !!platform,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => check(false),
    request: () => check(true),
    setUnread(value: boolean, unreadCount = 0) {
      if (!closed) {
        unread = value;
        count = unreadCount;
        project();
      }
    },
    async dispose() {
      closed = true;
      host?.removeEventListener("focus", refresh);
      listeners.clear();
      project();
      while (writing) await writing;
    },
  };
}
export type UnreadIndicator = ReturnType<typeof createUnreadIndicator>;
