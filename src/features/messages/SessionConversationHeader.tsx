import { useEffect, useRef } from "react";
import { ArrowLeftIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./SessionConversation.module.css";

/** Shared channel Sessions only; the existing thread reader owns the title data. */
export function SessionConversationHeader({
  title,
  back,
}: {
  title: string;
  back(): void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <header className={styles.header}>
      <IconButton
        ref={button}
        size="toolbar"
        aria-label="Back to Sessions"
        icon={<ArrowLeftIcon size={24} aria-hidden="true" />}
        onClick={back}
      />
      <h2 title={title}>{title}</h2>
    </header>
  );
}
