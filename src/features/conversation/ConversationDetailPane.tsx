import {
  createContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "../panels/Panels.module.css";

type Owner = {
  id: object;
  /** Runs once the pane is in the document with this owner's detail. */
  shown?(): void;
  /** Another owner took the pane; this one must stop rendering into it. */
  displaced(): void;
};

/**
 * The workspace supplies geometry; each reader retains its panel's lifetime.
 * The pane has one owner at a time: showing a new one displaces the last.
 */
export const ConversationDetailPane = createContext<{
  container: HTMLElement;
  show(owner: object, handlers: Omit<Owner, "id">): () => void;
} | null>(null);

/** A stable portal destination lets nested readers share their host's split. */
export function useConversationDetailPane() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const current = useRef<Owner | null>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = styles.workspace ?? "";
    return element;
  });
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({
      container,
      show(id: object, handlers: Omit<Owner, "id">) {
        const previous = current.current;
        const next = { id, ...handlers };
        current.current = next;
        setOwner(next);
        if (previous && previous.id !== id) previous.displaced();
        return () => {
          if (current.current !== next) return;
          current.current = null;
          setOwner(null);
        };
      },
    }),
    [container],
  );
  useLayoutEffect(() => {
    if (!mount) return;
    mount.appendChild(container);
    owner?.shown?.();
  }, [mount, container, owner]);
  useLayoutEffect(() => () => container.remove(), [container]);
  return {
    value,
    open: !!owner,
    companion: owner ? (
      <div ref={setMount} className={styles.workspace} />
    ) : undefined,
  };
}
