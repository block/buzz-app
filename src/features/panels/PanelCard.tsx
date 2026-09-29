import { useLayoutEffect, useRef } from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowLeftIcon, XIcon } from "../../shared/design-system/icons/index";
import type { PanelProps, RegisteredPanel } from "./service";
import { PanelSubviewHost } from "./PanelSubview";
import { PanelView } from "./PanelView";
import styles from "./Panels.module.css";

// Ordinary shared UI: the caller still owns placement and selection.
export function PanelCard({
  panel,
  closeLabel,
  back,
  ...props
}: PanelProps & {
  panel: RegisteredPanel;
  closeLabel?: string;
  back?: { label: string; onClick(): void } | undefined;
}) {
  const backButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    backButton.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      className={styles.cardLayout}
      aria-label={panel.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          (back?.onClick ?? props.close)();
        }
      }}
    >
      <Panel as="div">
        <PanelSubviewHost close={props.close}>
          <div className={styles.card}>
            <PanelHeader
              title={panel.title}
              navigation={
                back && (
                  <IconButton
                    ref={backButton}
                    size="toolbar"
                    aria-label={back.label}
                    onClick={back.onClick}
                    icon={<ArrowLeftIcon size={18} aria-hidden="true" />}
                  />
                )
              }
              actions={
                <IconButton
                  size="toolbar"
                  aria-label={closeLabel ?? `Close ${panel.title} panel`}
                  onClick={props.close}
                  icon={<XIcon size={18} aria-hidden="true" />}
                />
              }
            />
            <div className={styles.content}>
              <PanelView panel={panel} {...props} />
            </div>
          </div>
        </PanelSubviewHost>
      </Panel>
    </aside>
  );
}
