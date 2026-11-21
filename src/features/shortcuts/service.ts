// FOUNDATION: One dispatcher; plugin readiness/lifetime remain owned by Cordis.
import { TERMINAL_KEY_EVENT } from "./terminal-key-event";
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  activeModal,
  behindActiveOverlay,
} from "../../shared/design-system/overlayLayer";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import {
  inEditable,
  matches,
  normalizeShortcut,
  resolveBindings,
  type BindingRow,
  type KeyBinding,
  type ResolvedBinding,
  type NormalizedShortcut,
  type Shortcut,
} from "./bindings";
export type { KeyBinding, NormalizedShortcut, Shortcut } from "./bindings";
export type RegisteredShortcut = Contribution<NormalizedShortcut>;
/** Host-only: a field matches it itself, so it is listed in Settings but never reserved or run. */
export type HostShortcut = NormalizedShortcut &
  Readonly<{ local: boolean; yields: boolean }>;
export type Shortcuts = {
  register(shortcut: Shortcut): void;
  snapshot(): readonly RegisteredShortcut[];
  subscribe(listener: () => void): () => void;
};
/** Device-local user rebinds, keyed by host id or namespaced contribution key. */
export type BindingOverrides = {
  /** A stored override is a nonempty alias list; anything else means the default. */
  resolve(key: string): readonly KeyBinding[] | undefined;
  /** A new value on every change, so the resolved table is reused until then. */
  snapshot?(): unknown;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    shortcuts: Shortcuts;
  }
}

const MODAL = 'dialog[open], [aria-modal="true"]';
/** No modal, an addressable dialog that is its own navigation visit, or any other modal. */
type Modal = false | "visit" | true;
function eligibleIn(shortcut: Shortcut, editable: boolean, modal: Modal) {
  try {
    return (
      (!editable || shortcut.allowInEditable) &&
      (!modal ||
        shortcut.allowInModal ||
        (modal === "visit" && shortcut.allowInVisit)) &&
      (!shortcut.when || shortcut.when())
    );
  } catch (error) {
    console.error(`Shortcut predicate failed: ${shortcut.id}`, error);
    return false;
  }
}
function runShortcut(shortcut: Shortcut) {
  try {
    void Promise.resolve(shortcut.run()).catch((error) =>
      console.error(`Shortcut failed: ${shortcut.id}`, error),
    );
  } catch (error) {
    console.error(`Shortcut failed: ${shortcut.id}`, error);
  }
}
export class ShortcutsService extends Service implements Shortcuts {
  private readonly contributions;
  private readonly hostBindings = new Map<string, HostShortcut>();
  private readonly hostListeners = new Set<() => void>();
  private hostReady: readonly HostShortcut[] = Object.freeze([]);
  constructor(
    ctx: Context,
    host: Window | undefined = typeof window === "undefined"
      ? undefined
      : window,
    overrides?: BindingOverrides,
    /** Chords a native menu owns on this platform: dispatch leaves them to it. */
    native: readonly KeyBinding[] = [],
  ) {
    super(ctx, "shortcuts");
    this.overrides = overrides;
    this.native = Object.freeze(native.map((chord) => Object.freeze(chord)));
    this.contributions = createContributions<NormalizedShortcut>(ctx);
    const apple = /Mac|iPhone|iPad/.test(host?.navigator.platform ?? "");
    // The effective chord is resolved at match time, so a rebind never requires
    // re-registration and survives plugin disable/enable. Anything that is not
    // a binding list (a malformed store entry, an inherited property under a
    // key such as "constructor") means the default, so dispatch cannot throw.
    const dispatch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      // The native menu owns these: no web action runs and nothing is
      // prevented, so the key equivalent reaches it.
      if (matches(this.native, event, apple)) return;
      const editable = inEditable(event);
      const modal =
        modalOpen() ||
        event
          .composedPath()
          .some((target) => (target as Element).matches?.(MODAL));
      const eligible = (shortcut: Shortcut) =>
        eligibleIn(shortcut, editable, modal);
      const table = this.resolved();
      const bindingsFor = (shortcut: NormalizedShortcut, key: string) =>
        table.get(key)?.effective ?? shortcut.binding;
      // Host chords are reserved even while unavailable (e.g. Settings behind a modal).
      const reserved = [...this.hostBindings.values()].find(
        (shortcut) =>
          !shortcut.local &&
          matches(bindingsFor(shortcut, shortcut.id), event, apple),
      );
      const shortcut = reserved
        ? eligible(reserved)
          ? reserved
          : undefined
        : [...this.contributions.snapshot()]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .find(
              (shortcut) =>
                matches(bindingsFor(shortcut, shortcut.key), event, apple) &&
                eligible(shortcut),
            );
      if (!shortcut) return;
      event.preventDefault();
      if (event.repeat && !shortcut.repeat) return;
      runShortcut(shortcut);
    };
    const modalOpen = (): Modal => {
      if (!host?.document.querySelector(MODAL)) return false;
      // Only the topmost modal can be the current navigation visit, and
      // not while a menu or popover over it holds the interaction.
      const modal = activeModal(host.document);
      return modal?.matches("[data-navigation-visit]") &&
        !behindActiveOverlay(modal)
        ? "visit"
        : true;
    };
    // A non-keyboard request for a host shortcut, such as macOS mouse
    // back/forward: the chord's own eligibility, outside any editable.
    this.runHost = (id: string) => {
      const shortcut = this.hostBindings.get(id);
      if (
        !shortcut ||
        shortcut.local ||
        !eligibleIn(shortcut, false, modalOpen())
      )
        return false;
      runShortcut(shortcut);
      return true;
    };
    // Only xterm needs an early handoff: ordinary editors still handle keys first.
    const terminalKey = (event: Event) =>
      dispatch((event as CustomEvent<KeyboardEvent>).detail);
    ctx.effect(() => {
      host?.addEventListener(TERMINAL_KEY_EVENT, terminalKey);
      host?.addEventListener("keydown", dispatch);
      return () => {
        host?.removeEventListener("keydown", dispatch);
        host?.removeEventListener(TERMINAL_KEY_EVENT, terminalKey);
        this.hostBindings.clear();
        this.publishHost();
      };
    });
  }
  /** Host composition only: runs a host shortcut if it is eligible now. */
  readonly runHost: (id: string) => boolean;
  /** Chords owned by a native menu on this platform; never matched here. */
  readonly native: readonly KeyBinding[];
  private readonly overrides: BindingOverrides | undefined;
  private table:
    | Readonly<{
        hosts: readonly HostShortcut[];
        contributions: readonly RegisteredShortcut[];
        overrides: unknown;
        value: ReadonlyMap<string, ResolvedBinding>;
      }>
    | undefined;
  /** What every action answers to now, as dispatch and Settings apply it. */
  resolved(): ReadonlyMap<string, ResolvedBinding> {
    const hosts = this.hostReady;
    const contributions = this.contributions.snapshot();
    const overrides = this.overrides?.snapshot?.();
    const table = this.table;
    if (
      table &&
      table.hosts === hosts &&
      table.contributions === contributions &&
      table.overrides === overrides &&
      (!this.overrides || this.overrides.snapshot)
    )
      return table.value;
    const value = resolveBindings(
      this.bindingRows(),
      (key) => this.overrides?.resolve(key),
      this.native,
    );
    this.table = { hosts, contributions, overrides, value };
    return value;
  }
  /** Every dispatcher action in Settings order: host by order, then contributions. */
  bindingRows(): BindingRow[] {
    return [
      ...[...this.hostBindings.values()]
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
        .map((shortcut) => ({
          key: shortcut.id,
          defaults: shortcut.binding,
          local: shortcut.local,
          yields: shortcut.yields,
        })),
      ...[...this.contributions.snapshot()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((shortcut) => ({ key: shortcut.key, defaults: shortcut.binding })),
    ];
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(shortcut: Shortcut) {
    this.contributions.register(this.ctx, normalizeShortcut(shortcut));
  }
  /** Host composition only; not part of the injected plugin contract. */
  registerHost(
    shortcut: Shortcut,
    {
      local = false,
      /** The default gives way to a saved shortcut on the same chord. */
      yields = false,
    } = {},
  ) {
    const entry: HostShortcut = Object.freeze({
      ...normalizeShortcut(shortcut),
      local,
      yields,
    });
    if (this.hostBindings.has(entry.id))
      throw new Error(`Host shortcut already registered: ${entry.id}`);
    this.hostBindings.set(entry.id, entry);
    this.publishHost();
    return () => {
      if (this.hostBindings.get(entry.id) !== entry) return;
      this.hostBindings.delete(entry.id);
      this.publishHost();
    };
  }
  /** Host-only read path for Settings; plugins keep seeing only contributions. */
  hostSnapshot = () => this.hostReady;
  hostSubscribe = (listener: () => void) => {
    this.hostListeners.add(listener);
    return () => {
      this.hostListeners.delete(listener);
    };
  };
  private publishHost() {
    this.hostReady = Object.freeze([...this.hostBindings.values()]);
    for (const listener of this.hostListeners) listener();
  }
}
