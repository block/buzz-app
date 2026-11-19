import { Service, type Context } from "@deepseek-ai/cordis";

export interface Seen {
  /** True if recorded, false if absent, undefined if the answer is unknown. */
  has(key: string): boolean | undefined;
  /** Record a key for the current identity. */
  mark(key: string): void;
  subscribe(listener: () => void): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    seen: Seen;
  }
}

type Viewer = {
  snapshot(): { viewer?: string };
  subscribe(listener: () => void): () => void;
};

type SeenState = {
  storageKey: string;
  saved: Set<string>;
  pending: Set<string>;
  complete: boolean;
};

function validKey(key: unknown): key is string {
  if (typeof key !== "string" || [...key].length > 96) return false;
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1;
}

export class SeenService extends Service implements Seen {
  private state: SeenState | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context, viewer: Viewer) {
    super(ctx, "seen");
    ctx.effect(() => {
      const identityChanged = () => {
        const { viewer: pubkey } = viewer.snapshot();
        const storageKey = pubkey && `buzz.seen.v1:${pubkey}`;
        if (this.state?.storageKey === storageKey) return;
        this.state = storageKey
          ? {
              storageKey,
              saved: new Set(),
              pending: new Set(),
              complete: false,
            }
          : undefined;
        if (this.state) this.read(this.state);
        this.emit();
      };
      const storageChanged = (event: StorageEvent) => {
        const state = this.state;
        if (!state || (event.key !== state.storageKey && event.key !== null))
          return;
        this.read(state);
        this.emit();
      };
      const stop = viewer.subscribe(identityChanged);
      globalThis.window?.addEventListener("storage", storageChanged);
      identityChanged();
      return () => {
        stop();
        globalThis.window?.removeEventListener("storage", storageChanged);
        this.state = undefined;
        this.listeners.clear();
      };
    });
  }

  has = (key: string): boolean | undefined => {
    const state = this.state;
    if (!state || !validKey(key)) return undefined;
    if (state.pending.has(key) || state.saved.has(key)) return true;
    return state.complete ? false : undefined;
  };

  mark = (key: string): void => {
    const state = this.state;
    if (!state || !validKey(key)) return;
    const known = state.pending.has(key) || state.saved.has(key);
    if (!known) {
      state.pending.add(key);
      this.emit();
    }
    if (!state.pending.size) return;

    const save = () => {
      if (this.state !== state || !state.pending.size) return;
      // Concurrent windows must merge with the current stored set inside the lock.
      this.read(state);
      if (state.complete) {
        try {
          const merged = new Set([...state.saved, ...state.pending]);
          localStorage.setItem(state.storageKey, JSON.stringify([...merged]));
          state.saved = merged;
          state.pending.clear();
        } catch {
          // Keep the mark active in this window and retry on a later mark.
        }
      }
      this.emit();
    };
    const locks = globalThis.navigator?.locks;
    if (locks) void locks.request(state.storageKey, save).catch(() => {});
    else save();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private read(state: SeenState) {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(state.storageKey) ?? "[]",
      );
      if (!Array.isArray(value) || !value.every(validKey))
        throw new Error("Invalid Seen storage");
      state.saved = new Set(value);
      state.complete = true;
    } catch {
      state.complete = false;
    }
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
