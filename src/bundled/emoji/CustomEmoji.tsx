import { useReadyImage } from "../../shared/design-system/useReadyImage";
import type { CustomEmoji as Emoji } from "../../features/relay/emoji";
import styles from "./Emoji.module.css";

/** Event URLs never bypass the captured community's media policy. */
export function CustomEmoji({
  emoji,
  media,
}: {
  emoji: Emoji;
  media(url: string): string | undefined;
}) {
  const src = media(emoji.url);
  const literal = `:${emoji.shortcode}:`;
  return src ? <EmojiImage key={src} src={src} literal={literal} /> : literal;
}

function EmojiImage({ src, literal }: { src: string; literal: string }) {
  const { status, image } = useReadyImage(src);
  return status !== "failed" ? (
    <img
      {...image}
      className={styles.customEmoji}
      data-copy-emoji={literal}
      draggable={false}
      alt={literal}
      title={literal}
      width={22}
      height={22}
    />
  ) : (
    literal
  );
}
