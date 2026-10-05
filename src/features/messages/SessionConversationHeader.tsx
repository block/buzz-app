import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ChatsCircleIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./SessionConversation.module.css";

/** Shared channel Sessions only; the existing thread reader owns the title data. */
export function SessionConversationHeader({
  title,
  back,
  share,
  onOpenInThread,
}: {
  title: string;
  back(): void;
  onOpenInThread?: (() => void) | undefined;
  share?: ((title: string) => string | undefined) | undefined;
}) {
  const [error, setError] = useState<string>();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <header data-buzz-ui="" className={styles.header}>
      <IconButton
        ref={button}
        size="toolbar"
        aria-label="Back to Sessions"
        icon={<ArrowLeftIcon size={24} aria-hidden="true" />}
        onClick={back}
      />
      <h2 title={title}>{title}</h2>
      <div className={styles.actions}>
        {share && (
          <IconButton
            size="sm"
            aria-label="Share in channel"
            title="Share in channel"
            icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
            onClick={() => setError(share(title))}
          />
        )}
        {onOpenInThread && (
          <IconButton
            size="sm"
            aria-label="Open in thread"
            title="Open in thread"
            icon={<ChatsCircleIcon size={16} aria-hidden="true" />}
            onClick={onOpenInThread}
          />
        )}
      </div>
      {error && (
        <p className={styles.shareError} role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
