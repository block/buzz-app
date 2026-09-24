import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import styles from "./Status.module.css";

export function StatusEmoji({
  value,
  session,
  decorative = false,
}: {
  value: string;
  session: RelaySession;
  decorative?: boolean;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const code = /^:([^:\s]+):$/.exec(value)?.[1];
  useEffect(() => {
    if (code) void session.emoji.ensure();
  }, [code, session]);
  const custom = code
    ? catalog.entries.find(
        (entry) => entry.shortcode.toLowerCase() === code.toLowerCase(),
      )
    : undefined;
  const source = custom ? session.media(custom.url) : undefined;
  const [failed, setFailed] = useState<string>();
  if (!value) return null;
  return source && source !== failed ? (
    <img
      className={styles.emoji}
      src={source}
      alt={decorative ? "" : value}
      aria-hidden={decorative || undefined}
      width={20}
      height={20}
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(source)}
    />
  ) : (
    <span
      className={styles.emojiFallback}
      data-custom={code ? "" : undefined}
      aria-hidden={decorative || undefined}
    >
      {value}
    </span>
  );
}
