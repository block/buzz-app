import { createContext, type ReactNode } from "react";
import "../styles/action-list.css";

export const ActionListDismiss = createContext<(() => void) | null>(null);

/** Label existing controls in a list; portalled dialogs keep their own presentation. */
export function ActionList({
  children,
  onAction,
}: {
  children: ReactNode;
  onAction?: (() => void) | undefined;
}) {
  return (
    <ActionListDismiss value={onAction ?? null}>
      <div className="buzz-action-list" data-action-list="">
        {children}
      </div>
    </ActionListDismiss>
  );
}
