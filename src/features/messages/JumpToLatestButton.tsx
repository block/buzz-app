import type { ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

export function JumpToLatestButton({
  visible,
  newMessageCount,
  onClick,
}: {
  visible: boolean;
  newMessageCount: number;
  onClick(): void;
}) {
  const label =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
      : "Jump to latest";
  return (
    <JumpButton
      className={styles.jumpToLatest}
      visible={visible}
      onClick={onClick}
      data-jump-to-latest=""
    >
      <ArrowDownIcon size={16} aria-hidden="true" />
      {label}
    </JumpButton>
  );
}

/** The history's top edge counterpart to Jump to latest. */
export function JumpToTopButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick(): void;
}) {
  return (
    <JumpButton
      className={styles.jumpToTop}
      visible={visible}
      onClick={onClick}
      data-jump-to-top=""
    >
      <ArrowUpIcon size={16} aria-hidden="true" />
      Jump to top
    </JumpButton>
  );
}

function JumpButton({
  className,
  visible,
  onClick,
  children,
  ...data
}: {
  className: string | undefined;
  visible: boolean;
  onClick(): void;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div
      className={className}
      inert={!visible}
      aria-hidden={!visible}
      data-visible={visible}
    >
      <div className={styles.jumpToLatestSurface}>
        <Button
          {...data}
          size="xs"
          shape="capsule"
          variant="ghost"
          onClick={onClick}
        >
          {children}
        </Button>
      </div>
    </div>
  );
}
