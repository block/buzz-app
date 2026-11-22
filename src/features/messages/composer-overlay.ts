import {
  createContext,
  createElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/** One view's composer, as the rows above it see it: the form mounted for it,
 * so a sheet opened from a row can be drawn around it. */
export type ComposerHandle = Readonly<{
  /** The mounted form, or null while none is shown. */
  form(): HTMLElement | null;
  /** Mounts `form` as this view's composer; returns its release. */
  attach(form: HTMLElement): () => void;
  subscribe(listener: () => void): () => void;
}>;
export function createComposerHandle(): ComposerHandle {
  let current: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
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

/** The view rows read in, with its composer: a conversation, or one of its
 * threads (inline or in a tab), named by its root. */
export type ComposerView = Readonly<{
  handle: ComposerHandle;
  rootId?: string | undefined;
  /** False while the view is a hidden tab: its dialogs stay closed. */
  shown: boolean;
  /** A view the address never names, such as a media viewer's comments: its
   * details open in place. */
  local?: boolean | undefined;
}>;
const ComposerScope = createContext<ComposerView | undefined>(undefined);
export const useComposerScope = () => useContext(ComposerScope);

/** Starts a view: rows and the composer below it share its handle. */
export function ComposerScopeProvider({
  rootId,
  shown = true,
  local,
  children,
}: {
  rootId?: string | undefined;
  shown?: boolean | undefined;
  local?: boolean | undefined;
  children: ReactNode;
}) {
  const [handle] = useState(createComposerHandle);
  const value = useMemo(
    () => ({ handle, rootId, shown, local }),
    [handle, rootId, shown, local],
  );
  return createElement(ComposerScope.Provider, { value }, children);
}

/** Where a composer is on screen, only so a sheet can be drawn around it. */
export type ComposerOverlayHost = Readonly<{
  composer: HTMLElement;
  /** The composer's pane: the sheet is drawn and clipped within it. */
  pane: HTMLElement;
  /** What a media sheet spans: the workspace around the pane. */
  viewport?: HTMLElement | undefined;
}>;
/** The view a row opened media from: its composer, and the thread the media
 * is in, whose comments the media sheet reads. */
export type MediaReviewOrigin = Readonly<{
  host: ComposerOverlayHost;
  rootId: string;
}>;

/** Where `handle`'s composer is now, while it is on screen. */
export function composerHost(
  handle: ComposerHandle | undefined,
): ComposerOverlayHost | null {
  const composer = handle?.form();
  if (!composer?.isConnected || !composer.getClientRects().length) return null;
  const pane =
    composer.closest<HTMLElement>("[data-composer-host]") ??
    composer.parentElement;
  return pane ? { composer, pane } : null;
}

const noSubscription = () => () => {};
/** Changes as `handle`'s composer mounts and leaves. */
export function useComposerForm(handle: ComposerHandle | undefined) {
  return useSyncExternalStore(
    handle?.subscribe ?? noSubscription,
    () => handle?.form() ?? null,
    () => handle?.form() ?? null,
  );
}

/** Mounts the form as its view's composer. */
export function useOverlayComposerRef(ref: RefObject<HTMLFormElement | null>) {
  const handle = useComposerScope()?.handle;
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
