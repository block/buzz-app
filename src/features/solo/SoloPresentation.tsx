import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { ReactNode } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type {
  SoloDraftStart,
  SoloRegionBinding,
  SoloRegionSource,
} from "../channel-navigation/solo-navigation-contract";
import styles from "./Solo.module.css";

export function SoloDraftView({
  children,
  actions,
  header,
}: {
  actions?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={styles.work}
      data-attachment-drop-zone=""
      aria-label="New chat"
    >
      {header ?? (
        <SoloTitle channel={{ name: "New chat" }}>{actions}</SoloTitle>
      )}
      <div className={styles.start}>
        <div className={styles.startContent}>{children}</div>
      </div>
    </section>
  );
}

/** A broken optional title must not take away the standard composer or settings. */
export function SoloDraftHeader({
  owner,
  input,
  actions,
}: {
  owner: { source: SoloRegionSource; binding: SoloRegionBinding } | undefined;
  input: SoloDraftStart;
  actions: ReactNode;
}) {
  let title = "New chat";
  let failed = false;
  try {
    const path = owner?.source.draftHeader?.(owner.binding, input);
    if (path !== undefined) {
      if (
        !Array.isArray(path) ||
        path.length > 6 ||
        path.some(
          (label) =>
            typeof label !== "string" || !label.trim() || label.length > 160,
        )
      )
        throw new Error("Invalid draft header labels");
      if (path.length) title = path.join(" › ");
    }
  } catch {
    failed = true;
  }
  return (
    <>
      <SoloTitle channel={{ name: title }}>{actions}</SoloTitle>
      {failed && (
        <p role="alert">This plugin’s draft location is unavailable.</p>
      )}
    </>
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
}: {
  channel: Pick<ChannelSummary, "name">;
  children?: ReactNode;
}) {
  const Icon = ChatCircleIcon;
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel title={channel.name} icon={<Icon size="1rem" />} />
      }
      actions={children}
    />
  );
}
