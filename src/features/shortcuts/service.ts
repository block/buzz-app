// FOUNDATION: One dispatcher; plugin readiness/lifetime remain owned by Cordis.
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import {
  inEditable,
  matches,
  normalizeShortcut,
  type Shortcut,
} from "./bindings";
export type { KeyBinding, Shortcut } from "./bindings";
export type RegisteredShortcut = Contribution<Shortcut>;
export type Shortcuts = {
  register(shortcut: Shortcut): void;
  snapshot(): readonly RegisteredShortcut[];
  subscribe(listener: () => void): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    shortcuts: Shortcuts;
  }
}

export class ShortcutsService extends Service implements Shortcuts {
  private readonly contributions;
  private readonly hostBindings = new Map<string, Shortcut>();
  constructor(
    ctx: Context,
    host: Window | undefined = typeof window === "undefined"
      ? undefined
      : window,
  ) {
    super(ctx, "shortcuts");
    this.contributions = createContributions<Shortcut>(ctx);
    const apple = /Mac|iPhone|iPad/.test(host?.navigator.platform ?? "");
    const dispatch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      const editable = inEditable(event);
      const modal = !!host?.document.querySelector(
        'dialog[open], [aria-modal="true"]',
      );
      const eligible = (shortcut: Shortcut) => {
        try {
          return (
            (!editable || shortcut.allowInEditable) &&
            (!modal || shortcut.allowInModal) &&
            (!shortcut.when || shortcut.when())
          );
        } catch (error) {
          console.error(`Shortcut predicate failed: ${shortcut.id}`, error);
          return false;
        }
      };
      // Host chords are reserved even while unavailable (e.g. Settings behind a modal).
      const reserved = [...this.hostBindings.values()].find((shortcut) =>
        matches(shortcut, event, apple),
      );
      const shortcut = reserved
        ? eligible(reserved)
          ? reserved
          : undefined
        : [...this.contributions.snapshot()]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .find(
              (shortcut) =>
                matches(shortcut, event, apple) && eligible(shortcut),
            );
      if (!shortcut) return;
      event.preventDefault();
      if (event.repeat && !shortcut.repeat) return;
      try {
        void Promise.resolve(shortcut.run()).catch((error) =>
          console.error(`Shortcut failed: ${shortcut.id}`, error),
        );
      } catch (error) {
        console.error(`Shortcut failed: ${shortcut.id}`, error);
      }
    };
    ctx.effect(() => {
      host?.addEventListener("keydown", dispatch);
      return () => {
        host?.removeEventListener("keydown", dispatch);
        this.hostBindings.clear();
      };
    });
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(shortcut: Shortcut) {
    this.contributions.register(this.ctx, normalizeShortcut(shortcut));
  }
  /** Host composition only; not part of the injected plugin contract. */
  registerHost(shortcut: Shortcut) {
    const entry = normalizeShortcut(shortcut);
    if (this.hostBindings.has(entry.id))
      throw new Error(`Host shortcut already registered: ${entry.id}`);
    this.hostBindings.set(entry.id, entry);
    return () => {
      if (this.hostBindings.get(entry.id) === entry)
        this.hostBindings.delete(entry.id);
    };
  }
}
