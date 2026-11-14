import { ChatCircleIcon } from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import styles from "./NoConversationSelected.module.css";

export function NoConversationSelected() {
  return (
    <div className={styles.card}>
      <EmptyState icon={<ChatCircleIcon />} title="No conversation selected" />
    </div>
  );
}
