import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type DockPermission =
  | "default"
  | "enabled"
  | "disabled"
  | "denied"
  | "unavailable";
export interface DockPlatform {
  permission(request: boolean): Promise<DockPermission>;
  set(unread: boolean): Promise<void>;
}
export function dockPlatform(): DockPlatform | undefined {
  if (!isTauri() || !/Mac/i.test(globalThis.navigator?.platform ?? "")) return;
  return {
    permission: (request) => invoke("dock_permission", { request }),
    set: (unread) => getCurrentWindow().setBadgeLabel(unread ? "•" : undefined),
  };
}

/** One ordered native projection. Pending work always converges on current intent. */
export function createDockBadge(
  platform = dockPlatform(),
  host:
    | Pick<Window, "addEventListener" | "removeEventListener">
    | undefined = typeof window === "undefined" ? undefined : window,
) {
  let closed = false,
    unread = false;
  let state = Object.freeze({
    permission: "unavailable" as DockPermission,
    requesting: false,
    error: null as string | null,
  });
  const listeners = new Set<() => void>();
  let desired = false;
  let applied: boolean | undefined;
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
    desired = !closed && unread && state.permission === "enabled";
    if (!platform || writing || desired === applied) return;
    let attempted = desired;
    writing = (async () => {
      while (applied !== desired) {
        const next = desired;
        attempted = next;
        try {
          await platform.set(next);
          applied = next;
        } catch (error) {
          failed(error);
          // No retry loop. A later user action or unread transition can retry.
          if (desired === next) break;
        }
      }
    })().finally(() => {
      writing = undefined;
      if (desired !== attempted) project();
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
  project(); // Clear an earlier frontend's label before observing any new state.
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
    setUnread(value: boolean) {
      if (!closed) {
        unread = value;
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
export type DockBadge = ReturnType<typeof createDockBadge>;
