import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./SessionConversation.module.css";

/** Shared channel Sessions only; the existing thread reader owns the title data. */
export function SessionConversationHeader({
  title,
  back,
  share,
}: {
  title: string;
  back(): void;
  share?: ((title: string) => string | undefined) | undefined;
}) {
  const [error, setError] = useState<string>();
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
      {share && (
        <Button
          variant="ghost"
          size="compact"
          onClick={() => setError(share(title))}
        >
          Share in channel
        </Button>
      )}
      {error && (
        <p className={styles.shareError} role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
