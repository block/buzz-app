import { Popover } from "@base-ui/react/popover";
import { useRef, useState, type ReactNode } from "react";
import { ArrowsOutIcon, XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Shimmer } from "../../shared/design-system/ui/Shimmer";
import styles from "./ActivityPopover.module.css";

/** Based on PR #406: inspect work without changing the thread's layout. */
export function ActivityPopover({
  name,
  label,
  working,
  children,
  open,
  onOpenChange,
  onExpand,
  finalFocus,
}: {
  name: string;
  label: string;
  working: boolean;
  children: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  onExpand?: (() => void) | undefined;
  finalFocus(): boolean;
}) {
  const [keyboard, setKeyboard] = useState(false);
  const hoverOnly = useRef(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) hoverOnly.current = details.reason === "trigger-hover";
        if (
          !next &&
          (details.reason === "outside-press" || details.reason === "focus-out")
        )
          hoverOnly.current = true;
        setKeyboard(details.event.type.startsWith("key"));
        onOpenChange(next);
      }}
    >
      <Popover.Trigger
        className={`text-body-sm ${styles.trigger}`}
        openOnHover
        delay={250}
        closeDelay={150}
      >
        <Shimmer className="text-body-sm text-subtle" active={working}>
          {label}
        </Shimmer>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="buzz-popover-positioner"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <Popover.Popup
            className={`floating-surface ${styles.popup}`}
            data-buzz-ui=""
            data-keyboard={keyboard || undefined}
            onFocusCapture={() => {
              hoverOnly.current = false;
            }}
            finalFocus={() => !hoverOnly.current && finalFocus()}
          >
            {open && (
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
                        onClick={onExpand}
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
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
