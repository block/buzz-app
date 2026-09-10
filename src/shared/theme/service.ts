/** Host-owned, device-local appearance. Never depends on plugin/relay readiness. */
export type ColorMode = "light" | "dark";
export const APPEARANCE_KEY = "buzz-appearance.v1";
export const parseColorMode = (value: unknown): ColorMode =>
  value === "dark" ? "dark" : "light";

export interface AppearanceSnapshot {
  readonly mode: ColorMode;
  readonly error: string | null;
}

export function createAppearance(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let state: AppearanceSnapshot = { mode: "light", error: null };
  let disposed = false;
  const listeners = new Set<() => void>();
  const apply = () => {
    if (!host) return;
    const root = host.document.documentElement;
    root.dataset.colorMode = state.mode;
    // CSS owns the palette; browser chrome derives from the same canvas token.
    host.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        host.getComputedStyle(root).getPropertyValue("--workspace").trim(),
      );
  };
  const notify = () => {
    apply();
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      state = {
        mode: parseColorMode(host?.localStorage.getItem(APPEARANCE_KEY)),
        error: null,
      };
    } catch {
      state = {
        ...state,
        error:
          "Appearance could not be restored. Choose a mode to try saving it again.",
      };
    }
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== APPEARANCE_KEY && event.key !== null) return;
    // Re-read the current value: an older queued event must not undo a newer save.
    try {
      if (event.storageArea !== host?.localStorage) return;
      restore();
    } catch {
      restore();
    }
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
    setMode(mode: ColorMode) {
      if (disposed || (mode !== "light" && mode !== "dark")) return;
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(APPEARANCE_KEY, mode);
      } catch {
        error =
          "This appearance is active, but could not be saved on this device. Try again.";
      }
      state = { mode, error };
      notify();
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type Appearance = ReturnType<typeof createAppearance>;
