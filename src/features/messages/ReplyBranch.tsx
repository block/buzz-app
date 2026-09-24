import { Collapsible } from "@base-ui/react/collapsible";
import { useRef, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

/** Messaging composition, not a generic tree widget: replies remain readable lists. */
export function ReplyBranch({
  count,
  open,
  depth,
  onOpenChange,
  children,
}: {
  count: number;
  open: boolean;
  depth: number;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className={styles.replyBranch}
      data-depth={Math.min(depth, 6)}
    >
      <Collapsible.Trigger
        ref={trigger}
        render={(props) => (
          <Button {...props} variant="ghost" size="sm">
            {props.children}
          </Button>
        )}
        onClick={() => {
          if (!open)
            requestAnimationFrame(() =>
              panel.current
                ?.querySelector("[data-message-id]")
                ?.scrollIntoView({
                  block: "nearest",
                }),
            );
        }}
      >
        {open
          ? "Hide replies"
          : `${count} ${count === 1 ? "reply" : "replies"} loaded`}
      </Collapsible.Trigger>
      <Collapsible.Panel ref={panel} className={styles.replyBranchPanel}>
        <Collapsible.Trigger
          className={styles.replyBranchRail}
          aria-label="Collapse replies"
          tabIndex={-1}
          onClick={() => trigger.current?.focus({ preventScroll: true })}
        />
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
