import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** Visual publication only. Covering a pane never retires its live owners. */
export const WorkspacePresentation = createContext(true);
export const useWorkspacePresentation = () => useContext(WorkspacePresentation);

type Publication = {
  presented: boolean;
  listeners: Set<() => void>;
  snapshot(): boolean;
  subscribe(listener: () => void): () => void;
};
// Portals inherit their origin's React context, not their destination's. The
// retained DOM host carries its destination's publication state across moves.
// Weak ownership matches the existing node lifetime: closed tabs are not cached.
const publications = new WeakMap<HTMLElement, Publication>();
function publicationFor(node: HTMLElement) {
  let publication = publications.get(node);
  if (!publication) {
    const current: Publication = {
      presented: false,
      listeners: new Set(),
      snapshot: () => current.presented,
      subscribe(listener) {
        current.listeners.add(listener);
        return () => current.listeners.delete(listener);
      },
    };
    publications.set(node, current);
    publication = current;
  }
  return publication;
}

/** Only the slot currently attached to this node may publish its visibility. */
export function publishWorkspacePresentation(
  node: HTMLElement,
  presented: boolean,
) {
  const publication = publicationFor(node);
  if (publication.presented === presented) return;
  publication.presented = presented;
  for (const listener of publication.listeners) listener();
}

const alwaysPresented = () => true;
const noSubscription = () => () => {};

/** Rebind pure visual publication to the destination without remounting owners. */
export function RetainedWorkspacePresentation({
  target,
  children,
}: {
  target?: HTMLElement | undefined;
  children: ReactNode;
}) {
  const origin = useWorkspacePresentation();
  const publication = target && publicationFor(target);
  const presented = useSyncExternalStore(
    publication?.subscribe ?? noSubscription,
    publication?.snapshot ?? alwaysPresented,
    publication?.snapshot ?? alwaysPresented,
  );
  return (
    <WorkspacePresentation.Provider value={target ? presented : origin}>
      {children}
    </WorkspacePresentation.Provider>
  );
}
