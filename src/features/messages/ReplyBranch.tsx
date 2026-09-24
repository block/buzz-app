import { Collapsible } from "@base-ui/react/collapsible";
import { useRef, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MinusIcon } from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

/** Messaging composition, not a generic tree widget: replies remain readable lists. */
export function ReplyBranch({
  message,
  layout,
  summary,
  label,
  hideLabel = "Hide replies",
  collapsible = true,
  open,
  depth,
  onOpenChange,
  children,
}: {
  message: ReactNode | ((collapseControl: ReactNode) => ReactNode);
  layout: "thread" | "continuation";
  summary: ReactNode;
  label: string;
  hideLabel?: string;
  collapsible?: boolean;
  open: boolean;
  depth: number;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rowTrigger = useRef<HTMLButtonElement>(null);
  const collapseControl =
    open && collapsible ? (
      <span className={styles.replyBranchRowControl}>
        <Collapsible.Trigger
          ref={rowTrigger}
          render={
            <IconButton
              size="sm"
              aria-label="Collapse this branch"
              title="Collapse this branch"
              icon={<MinusIcon />}
            />
          }
          onClick={() =>
            requestAnimationFrame(() =>
              trigger.current?.focus({ preventScroll: true }),
            )
          }
        />
      </span>
    ) : null;
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className={styles.replyBranch}
      data-depth={Math.min(depth, 6)}
      data-open={open && collapsible}
      data-layout={layout}
    >
      <div className={styles.replyBranchMessage}>
        {typeof message === "function" ? message(collapseControl) : message}
      </div>
      {collapsible && (
        <div className={styles.replyBranchSummary}>
          <Collapsible.Trigger
            ref={trigger}
            render={(props) => (
              <Button {...props} variant="link" size="sm">
                {props.children}
              </Button>
            )}
            onClick={() => {
              if (!open)
                requestAnimationFrame(() => {
                  panel.current
                    ?.querySelector("[data-message-id]")
                    ?.scrollIntoView({ block: "nearest" });
                  const rail =
                    panel.current?.querySelector<HTMLButtonElement>("button");
                  const target = rail?.getClientRects().length
                    ? rail
                    : rowTrigger.current;
                  if (target?.getClientRects().length)
                    target.focus({ preventScroll: true });
                });
            }}
            aria-label={open ? hideLabel : label}
          >
            {open ? hideLabel : summary}
          </Collapsible.Trigger>
        </div>
      )}
      <Collapsible.Panel ref={panel} className={styles.replyBranchPanel}>
        {collapsible && (
          <Collapsible.Trigger
            className={styles.replyBranchRail}
            aria-label={hideLabel}
            onClick={() =>
              requestAnimationFrame(() =>
                trigger.current?.focus({ preventScroll: true }),
              )
            }
          />
        )}
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
