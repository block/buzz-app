import { useContext, useEffect, useRef, useState } from "react";
import { ReactionAnimation } from "../../features/messages/ReactionAnimation";
import type { InlineContent } from "../../features/conversation/contracts";
import { notoAsset, playNoto, stopNoto } from "./noto-playback";
import styles from "./Emoji.module.css";

const openedAt = Date.now();
const played = new Set<string>();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function animatedEmojiMatches(text: string) {
  return Array.from(segmenter.segment(text)).flatMap(({ segment, index }) =>
    notoAsset(segment) ? [{ start: index, end: index + segment.length }] : [],
  );
}
export function AnimatedEmoji({
  text,
  content,
  hoverOption = false,
}: {
  text: string;
  content?: InlineContent;
  hoverOption?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const asset = notoAsset(text);
  const reactionAnimation = useContext(ReactionAnimation);
  const message = content?.message;
  const hoverReaction = !!content?.reaction;
  const initial =
    message &&
    !content?.reaction &&
    (message.createdAtMs ?? message.createdAt * 1000) >= openedAt;
  const playbackKey = `${message?.id}:${text}`;
  useEffect(() => {
    const node = image.current;
    if (!node) return;
    if (message?.id === "composer") {
      playNoto(node, text);
    } else if (initial && !played.has(playbackKey)) {
      playNoto(node, text, () => {
        played.add(playbackKey);
        const oldest = played.values().next().value;
        if (played.size > 2000 && oldest) played.delete(oldest);
      });
    }
    return () => stopNoto(node);
  }, [initial, playbackKey, text, message?.id]);
  useEffect(() => {
    const node = image.current;
    if (!reactionAnimation?.celebrate || !node) return;
    stopNoto(node);
    playNoto(node, text, reactionAnimation.start);
  }, [reactionAnimation, text]);
  useEffect(() => {
    const node = image.current;
    const option = hoverOption
      ? node?.closest('[role="option"]')
      : hoverReaction
        ? node?.closest("button")
        : null;
    if (!node || !option) return;
    const play = () => playNoto(node, text);
    option.addEventListener("pointerenter", play);
    return () => option.removeEventListener("pointerenter", play);
  }, [hoverOption, hoverReaction, text]);
  if (!asset || failed) return text;
  return (
    <img
      ref={image}
      className={styles.animatedEmoji}
      src={`/emoji/noto-animated/${asset.code}.svg`}
      alt={text}
      data-copy-emoji={text}
      data-animation-duration={asset.duration}
      draggable={false}
      loading="lazy"
      onPointerEnter={
        hoverOption || hoverReaction
          ? undefined
          : (event) => playNoto(event.currentTarget, text)
      }
      onError={(event) => {
        if (event.currentTarget.src.startsWith("blob:"))
          stopNoto(event.currentTarget);
        else setFailed(true);
      }}
    />
  );
}
