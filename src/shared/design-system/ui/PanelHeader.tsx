import { HeaderIcon } from "./HeaderIcon";
import { ScrollEdgeMaterial } from "./ScrollEdgeMaterial";
import { SquaresFourIcon } from "../icons";
import type { ReactNode } from "react";

/** Shared header frame. Product identity and controls are supplied through slots.
 * Workspace dragging and tab strips are owned by the layout, not this frame. */
export function PanelHeader({
  title,
  icon,
  navigation,
  actions,
  variant = "default",
  divider = false,
  historyOverlay = false,
}: {
  title: ReactNode;
  icon?: ReactNode;
  navigation?: ReactNode;
  actions?: ReactNode;
  variant?: "default" | "compact" | "card" | "conversation";
  /** Keep the separator's space while omitting its visible line. */
  divider?: boolean;
  /** Conversation history scrolls behind this floating identity. */
  historyOverlay?: boolean;
}) {
  return (
    <header
      data-buzz-ui=""
      className="panel-header"
      data-variant={variant}
      data-divider={divider ? undefined : "hidden"}
      data-history-overlay={historyOverlay || undefined}
    >
      {historyOverlay && (
        <ScrollEdgeMaterial edge="top" className="panel-header-material" />
      )}
      {navigation}
      <div className="panel-header-title">
        {icon}
        {typeof title === "string" ? (
          <h2
            className={`${variant === "conversation" && icon ? "text-label-sm" : "text-label"} text-primary`}
          >
            {title}
          </h2>
        ) : (
          title
        )}
      </div>
      {actions ? <div className="panel-header-actions">{actions}</div> : null}
    </header>
  );
}

/** Static identity aligned with the navigation tabs, without adding a tab stop. */
export function PanelHeaderLabel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-header-label">
      <HeaderIcon>{icon ?? <SquaresFourIcon size={24} />}</HeaderIcon>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
