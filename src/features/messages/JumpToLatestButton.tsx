import { ArrowDownIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./Messages.module.css";

const label = "Jump to latest message";

export function JumpToLatestButton({ onClick }: { onClick(): void }) {
  return (
    <div className={styles.jumpToLatest}>
      <IconButton
        aria-label={label}
        title={label}
        onClick={onClick}
        icon={<ArrowDownIcon size={18} aria-hidden="true" />}
      />
    </div>
  );
}
