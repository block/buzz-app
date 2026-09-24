import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { normalizeShortcode } from "../../features/relay/emoji";
import styles from "./Channels.module.css";

export function SidebarSectionIcon({
  icon,
  session,
}: {
  icon: string;
  session: RelaySession;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const match = /^:([^:\s]+):$/.exec(icon);
  const shortcode = match ? normalizeShortcode(match[1] ?? "") : undefined;
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    if (shortcode) void session.emoji.ensure();
  }, [session, shortcode]);

  const custom = shortcode
    ? catalog.entries.find((entry) => entry.shortcode === shortcode)
    : undefined;
  const source = custom ? session.media(custom.url) : undefined;
  useEffect(() => {
    setLoaded(undefined);
    setFailed(undefined);
    if (!source) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setLoaded(source);
    };
    image.onerror = () => {
      if (live) setFailed(source);
    };
    image.src = source;
    return () => {
      live = false;
    };
  }, [source]);

  const fallback = !shortcode
    ? icon
    : source
      ? failed === source
        ? icon
        : undefined
      : catalog.status === "ready"
        ? icon
        : undefined;

  return (
    <span className={styles.sectionIcon} aria-hidden="true">
      {source && loaded === source ? (
        <img src={source} alt="" draggable={false} />
      ) : (
        fallback
      )}
    </span>
  );
}
