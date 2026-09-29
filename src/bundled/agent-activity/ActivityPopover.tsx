import { Popover } from "@base-ui/react/popover";
import { useRef, useState, type ReactNode } from "react";
import { ArrowsOutIcon, XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Shimmer } from "../../shared/design-system/ui/Shimmer";
import styles from "./ActivityPopover.module.css";

/** Live activity text expands into detail without shifting the thread. */
export function ActivityPopover({
  name,
  label,
  working,
  children,
  onExpand,
}: {
  name: string;
  label: string;
  working: boolean;
  children: ReactNode;
  onExpand?: (() => boolean) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const expandedPanel = useRef(false);
  const [keyboard, setKeyboard] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) expandedPanel.current = false;
        setKeyboard(details.event.type.startsWith("key"));
        setOpen(nextOpen);
      }}
    >
      <Popover.Trigger
        className={`text-body-sm ${styles.trigger}`}
        aria-label={`${name} ${label}`}
        data-working={working || undefined}
      >
        <Shimmer
          className={`text-body-sm text-subtle ${styles.label}`}
          active={working}
        >
          {label}
        </Shimmer>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="buzz-popover-positioner"
          side="bottom"
          align="start"
          sideOffset={({ anchor }) => -anchor.height}
          collisionPadding={12}
        >
          <Popover.Popup
            className={`floating-surface ${styles.popup}`}
            data-buzz-ui=""
            data-keyboard={keyboard || undefined}
            finalFocus={() => !expandedPanel.current}
          >
            <div className={styles.content}>
              <header className={styles.header}>
                <div>
                  <Popover.Title className="text-label-sm">
                    {name}
                  </Popover.Title>
                  <Popover.Description className="text-body-sm text-subtle">
                    {label}
                  </Popover.Description>
                </div>
                <div className={styles.actions}>
                  {onExpand && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Open activity in panel"
                      onClick={() => {
                        if (onExpand()) {
                          expandedPanel.current = true;
                          setOpen(false);
                        }
                      }}
                    >
                      <ArrowsOutIcon size={16} />
                    </Button>
                  )}
                  <Popover.Close
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Close activity"
                      >
                        <XIcon size={16} />
                      </Button>
                    }
                  />
                </div>
              </header>
              <div className={styles.stream}>{children}</div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
