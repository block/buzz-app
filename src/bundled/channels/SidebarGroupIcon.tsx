import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { normalizeShortcode } from "../../features/relay/emoji";
import styles from "./SidebarGroupIcon.module.css";

type Session = Pick<RelaySession, "emoji" | "media">;

/** Decorative group icons share the community catalog, never a new read owner. */
export function SidebarGroupIcon({
  icon,
  session,
}: {
  icon: string;
  session: Session;
}) {
  const custom = icon.startsWith(":") && icon.endsWith(":");
  const shortcode = custom ? normalizeShortcode(icon) : undefined;
  return (
    <span className={styles.icon} aria-hidden="true" data-sidebar-group-icon="">
      {custom ? (
        shortcode ? (
          <CommunityIcon shortcode={shortcode} session={session} />
        ) : null
      ) : (
        icon
      )}
    </span>
  );
}

function Placeholder() {
  return <span className={styles.placeholder} data-loading="" />;
}

function CommunityIcon({
  shortcode,
  session,
}: {
  shortcode: string;
  session: Session;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  useEffect(() => {
    void session.emoji.ensure();
  }, [session.emoji]);
  const emoji = catalog.entries.find((entry) => entry.shortcode === shortcode);
  if (!emoji)
    return catalog.status === "idle" || catalog.status === "loading" ? (
      <Placeholder />
    ) : null;
  const src = session.media(emoji.url);
  return src ? <IconImage key={src} src={src} /> : null;
}

/** Unlike message emoji, decorative icons never fall back to shortcode text. */
function IconImage({ src }: { src: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  if (status === "error") return null;
  return (
    <>
      {status === "loading" && <Placeholder />}
      <img
        className={styles.image}
        src={src}
        alt=""
        draggable={false}
        data-loading={status === "loading" ? "" : undefined}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
      />
    </>
  );
}
