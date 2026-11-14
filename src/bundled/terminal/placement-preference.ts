/** Terminal-owned, device-local panel placement. */
export const TERMINAL_PLACEMENT_KEY = "buzz-terminal-placement.v1";
export type TerminalPlacement = "bottom" | "side" | "tab";
export const DEFAULT_PLACEMENT: TerminalPlacement = "bottom";
type Snapshot = {
  readonly placement: TerminalPlacement;
  readonly error: string | null;
};

export function parsePlacement(raw: unknown): TerminalPlacement | null {
  return raw === "bottom" || raw === "side" || raw === "tab" ? raw : null;
}

export function createTerminalPlacementPreference(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let state: Snapshot = { placement: DEFAULT_PLACEMENT, error: null };
  let disposed = false;
  let restoreFailed = false;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const restore = () => {
    restoreFailed = false;
    try {
      publish({
        placement:
          parsePlacement(host?.localStorage.getItem(TERMINAL_PLACEMENT_KEY)) ??
          DEFAULT_PLACEMENT,
        error: null,
      });
    } catch {
      restoreFailed = true;
      publish({
        placement: DEFAULT_PLACEMENT,
        error:
          "Your terminal placement could not be restored. The bottom drawer is active.",
      });
    }
  };
  const commit = (placement: TerminalPlacement) => {
    restoreFailed = false;
    let error: string | null = null;
    try {
      if (!host) throw new Error("No browser storage");
      if (placement === DEFAULT_PLACEMENT)
        host.localStorage.removeItem(TERMINAL_PLACEMENT_KEY);
      else host.localStorage.setItem(TERMINAL_PLACEMENT_KEY, placement);
    } catch {
      error =
        placement === DEFAULT_PLACEMENT
          ? "The bottom drawer is active, but this reset could not be saved on this device. Your previous placement may return after restarting. Try again."
          : "Your terminal placement is active, but could not be saved on this device. Try again.";
    }
    publish({ placement, error });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TERMINAL_PLACEMENT_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
    // Queued storage events may describe a choice that has already changed.
    restore();
  };
  restore();
  host?.addEventListener("storage", onStorage);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(placement: TerminalPlacement) {
      if (disposed) return;
      if (parsePlacement(placement) === null)
        throw new Error("Invalid terminal placement");
      commit(placement);
    },
    reset() {
      if (!disposed) commit(DEFAULT_PLACEMENT);
    },
    retry() {
      if (disposed) return;
      // Retrying a failed restore must not delete an unread saved choice.
      if (restoreFailed) restore();
      else commit(state.placement);
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type TerminalPlacementPreference = ReturnType<
  typeof createTerminalPlacementPreference
>;
