import { createContext, useLayoutEffect, useMemo, useState } from "react";
import styles from "../panels/Panels.module.css";

/** The workspace supplies geometry; each reader retains its panel's lifetime. */
export const ConversationDetailPane = createContext<{
  container: HTMLElement;
  show(owner: object, onShown?: () => void): () => void;
} | null>(null);

/** A stable portal destination lets nested readers share their host's split. */
export function useConversationDetailPane() {
  const [owner, setOwner] = useState<{
    id: object;
    onShown?: (() => void) | undefined;
  } | null>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = styles.workspace ?? "";
    return element;
  });
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({
      container,
      show(next: object, onShown?: () => void) {
        setOwner({ id: next, onShown });
        return () =>
          setOwner((current) => (current?.id === next ? null : current));
      },
    }),
    [container],
  );
  useLayoutEffect(() => {
    if (!mount) return;
    mount.appendChild(container);
    owner?.onShown?.();
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
