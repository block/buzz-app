import { useState } from "react";
import type { CustomEmoji as Emoji } from "../../features/relay/emoji";
import styles from "./Emoji.module.css";

// A transparent pixel: the placeholder never loads anything.
const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Event URLs never bypass the captured community's media policy. An emoji
 * whose media is unavailable or fails keeps its box as a placeholder of the
 * same size, so text never reflows around it (docs/channels.md). */
export function CustomEmoji({
  emoji,
  media,
}: {
  emoji: Emoji;
  media(url: string): string | undefined;
}) {
  const src = media(emoji.url);
  const [failed, setFailed] = useState<string>();
  const literal = `:${emoji.shortcode}:`;
  const shown = src && failed !== src ? src : undefined;
  return (
    <img
      className={styles.customEmoji}
      data-copy-emoji={literal}
      data-unavailable={shown ? undefined : ""}
      draggable={false}
      src={shown ?? PLACEHOLDER}
      alt={literal}
      title={literal}
      width={22}
      height={22}
      loading="lazy"
      onError={shown ? () => setFailed(shown) : undefined}
    />
  );
}
