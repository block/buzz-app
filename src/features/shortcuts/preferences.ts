/** Host-owned, device-local shortcut rebinds. Never depends on plugin/relay readiness. */
import { isKeyBinding, type KeyBinding } from "./bindings";

export const SHORTCUT_BINDINGS_KEY = "buzz-shortcut-bindings.v1";
export type ShortcutOverrides = Readonly<Record<string, KeyBinding>>;
export interface ShortcutBindingsSnapshot {
  readonly overrides: ShortcutOverrides;
  readonly error: string | null;
}

const RESTORE_ERROR =
  "Custom shortcuts could not be restored. Defaults are active; change a shortcut to try saving again.";
const SAVE_ERROR =
  "Your shortcuts are active, but could not be saved on this device. Try again.";

/** Keeps every well-formed entry and drops only malformed ones. */
export function parseOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key, binding]) => key.length > 0 && isKeyBinding(binding),
  ) as [string, KeyBinding][];
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, { key: name, mod, shift, alt }]) => [
        key,
        Object.freeze({
          key: name,
          ...(mod !== undefined && { mod }),
          ...(shift !== undefined && { shift }),
          ...(alt !== undefined && { alt }),
        }),
      ]),
    ),
  );
}

export function createShortcutBindings(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let state: ShortcutBindingsSnapshot = { overrides: {}, error: null };
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      const raw = host?.localStorage.getItem(SHORTCUT_BINDINGS_KEY);
      state = {
        overrides: raw ? parseOverrides(JSON.parse(raw)) : {},
        error: null,
      };
    } catch {
      state = { overrides: {}, error: RESTORE_ERROR };
    }
    notify();
  };
  // The change applies in memory even when the save fails; the page offers a retry.
  const commit = (overrides: ShortcutOverrides) => {
    let error: string | null = null;
    try {
      if (!host) throw new Error("No browser storage");
      if (Object.keys(overrides).length)
        host.localStorage.setItem(
          SHORTCUT_BINDINGS_KEY,
          JSON.stringify(overrides),
        );
      else host.localStorage.removeItem(SHORTCUT_BINDINGS_KEY);
    } catch {
      error = SAVE_ERROR;
    }
    state = { overrides, error };
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SHORTCUT_BINDINGS_KEY && event.key !== null) return;
    // Re-read the current value: an older queued event must not undo a newer save.
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
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
    /** Dispatcher lookup at match time; undefined means the registered default. */
    resolve: (key: string) => state.overrides[key],
    set(key: string, binding: KeyBinding | null) {
      if (disposed) return;
      if (binding !== null && !isKeyBinding(binding))
        throw new Error("Invalid shortcut binding");
      const rest = Object.fromEntries(
        Object.entries(state.overrides).filter(([entry]) => entry !== key),
      );
      commit(
        Object.freeze(
          binding === null
            ? rest
            : { ...rest, [key]: Object.freeze({ ...binding }) },
        ),
      );
    },
    reset() {
      if (!disposed) commit(Object.freeze({}));
    },
    /** Re-attempt persisting what is already active after a failed save. */
    retry() {
      if (!disposed) commit(state.overrides);
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type ShortcutBindings = ReturnType<typeof createShortcutBindings>;
