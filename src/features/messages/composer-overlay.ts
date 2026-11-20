import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import {
  threadPlacementPreference,
  useThreadPlacementPreference,
} from "./thread-preferences";

/** A composer's name, the way its draft is named: the channel's own composer
 * or a thread's reply box. */
export type ComposerName = string;
export const channelComposer = (channelId: string): ComposerName =>
  `channel:${channelId}`;
export const threadComposer = (
  channelId: string,
  rootId: string,
): ComposerName => `thread:${channelId}:${rootId}`;
/** The channel a composer writes to. */
export const composerChannel = (name: ComposerName) => name.split(":")[1] ?? "";
/** The thread a reply box writes to; none for a channel's composer. */
export const composerThread = (name: ComposerName) =>
  name.startsWith("thread:") ? name.split(":")[2] : undefined;

/** One conversation's composer, as the content below it sees it: its name,
 * and the form shown for it once mounted. What a row opens reads over the
 * composer of the scope it sits in. */
export type ComposerHandle = Readonly<{
  name: ComposerName;
  /** This scope alone: two scopes can share a name, as one channel in two
   * panes. */
  id: string;
  /** The mounted form, or null while none is shown. */
  form(): HTMLElement | null;
  /** Mounts `form` as this scope's composer; returns its release. */
  attach(form: HTMLElement): () => void;
  subscribe(listener: () => void): () => void;
}>;
let handles = 0;
export function createComposerHandle(name: ComposerName): ComposerHandle {
  const id = `${name}#${++handles}`;
  let current: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    name,
    id,
    form: () => current,
    attach: (form) => {
      current = form;
      changed();
      return () => {
        if (current !== form) return;
        current = null;
        changed();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The composer the content below writes with. Rows read it to open what
 * they read over it; it never changes while they are mounted. */
export const ComposerScope = createContext<ComposerHandle | undefined>(
  undefined,
);
export const useComposerScope = () => useContext(ComposerScope);

/** Where a composer is on screen, only so a sheet can be drawn around it. */
export type ComposerOverlayHost = Readonly<{
  composer: HTMLElement;
  pane: HTMLElement;
  /** Layout bounds may exceed the source reader for expanded media. */
  viewport: HTMLElement;
  container: HTMLElement;
}>;
export type MediaReviewOrigin = Readonly<{
  host: ComposerOverlayHost | null;
  rootId: string;
}>;

/** Where `handle`'s composer is now, while it is shown. */
export function composerHost(
  handle: ComposerHandle | undefined,
): ComposerOverlayHost | null {
  const composer = handle?.form();
  if (!composer?.isConnected) return null;
  const pane =
    composer.closest<HTMLElement>("[data-composer-host]") ??
    composer.parentElement;
  if (!pane) return null;
  // Beside the composer, even inside another sheet, so it rises above what
  // opens over it.
  return { composer, pane, viewport: pane, container: pane };
}

/** Where something opened from `handle`'s scope goes inline. Readers open
 * over their conversation only with the Inline setting; without a host, each
 * surface opens its tab, dialog or fullscreen viewer instead. */
export function overlayHost(
  handle: ComposerHandle | undefined,
): ComposerOverlayHost | null {
  if (threadPlacementPreference() !== "inline") return null;
  return composerHost(handle);
}

/** Changes as `handle`'s composer mounts and leaves. */
export function useComposerForm(handle: ComposerHandle | undefined) {
  return useSyncExternalStore(
    handle?.subscribe ?? noSubscription,
    () => handle?.form() ?? null,
    () => handle?.form() ?? null,
  );
}
const noSubscription = () => () => {};

/** Whether a reader opened from `handle`'s scope opens on its sheet, as its
 * composer comes and goes and the placement setting changes. */
export function useOpensOnSheet(handle: ComposerHandle | undefined): boolean {
  const { placement } = useThreadPlacementPreference();
  const form = useComposerForm(handle);
  return placement === "inline" && !!form;
}

/** Mounts the form as its scope's composer. */
export function useOverlayComposerRef(ref: RefObject<HTMLFormElement | null>) {
  const handle = useComposerScope();
  return useCallback(
    (element: HTMLFormElement | null) => {
      ref.current = element;
      if (!element) return;
      const release = handle?.attach(element);
      return () => {
        release?.();
        ref.current = null;
      };
    },
    [ref, handle],
  );
}

/** Resolves once no composer within `root` is sending, or `root` leaves the
 * page: unmounting a composer cancels its send. */
export function composerSettled(root: HTMLElement): Promise<void> {
  const busy = () =>
    root.isConnected &&
    !!root.querySelector('[data-message-composer][aria-busy="true"]');
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (busy()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(root.ownerDocument.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["aria-busy"],
    });
  });
}
