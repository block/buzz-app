import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { ReactNode } from "react";
import type { ChannelSummary } from "../relay/contracts";
import styles from "./Solo.module.css";

export function SoloDraftView({
  children,
  actions,
  title = "New chat",
  icon,
  embedded,
}: {
  actions?: ReactNode;
  title?: string;
  icon?: ReactNode;
  embedded?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <SoloConversationView
      title={title}
      icon={icon}
      actions={actions}
      embedded={embedded}
      attachmentDropZone
    >
      <div className={styles.start}>
        <div className={styles.startContent}>
          {embedded && actions && (
            <div className="flex justify-end px-3 py-2">{actions}</div>
          )}
          {children}
        </div>
      </div>
    </SoloConversationView>
  );
}

/** Shared Solo frame for a draft or started conversation in any host pane. */
export function SoloConversationView({
  children,
  actions,
  title,
  ariaLabel = title,
  icon,
  attachmentDropZone = false,
  embedded = false,
}: {
  actions?: ReactNode;
  title: string;
  ariaLabel?: string;
  icon?: ReactNode;
  children: ReactNode;
  attachmentDropZone?: boolean;
  /** The mounting panel supplies its own header and close controls. */
  embedded?: boolean | undefined;
}) {
  return (
    <section
      className={styles.work}
      {...(attachmentDropZone ? { "data-attachment-drop-zone": "" } : {})}
      aria-label={ariaLabel}
    >
      {!embedded && (
        <SoloTitle channel={{ name: title }} icon={icon}>
          {actions}
        </SoloTitle>
      )}
      {children}
    </section>
  );
}

/** Keep chat messages and their composer in the same column as a new draft. */
export function SoloColumn({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? (
    <div data-solo-column="" className={styles.column}>
      {children}
    </div>
  ) : (
    children
  );
}

/** A Solo chat's header: its name, then the actions the host supplies. */
export function SoloTitle({
  channel,
  children,
  icon,
}: {
  channel: Pick<ChannelSummary, "name">;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title={channel.name}
          icon={icon ?? <ChatCircleIcon size="1rem" />}
        />
      }
      actions={children}
    />
  );
}
