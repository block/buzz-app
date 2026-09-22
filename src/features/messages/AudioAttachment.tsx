import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "../../shared/design-system/icons/index";
import type { Attachment } from "../relay/contracts";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";

let playing: HTMLAudioElement | null = null;

function finiteDuration(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function AudioAttachment({
  attachment,
  source,
}: {
  attachment: Attachment;
  source: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() =>
    finiteDuration(attachment.duration),
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === source;
  const total = duration;

  useEffect(() => {
    const element = audio.current;
    return () => {
      if (playing === element) playing = null;
    };
  }, []);

  if (failed)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        Audio unavailable
      </span>
    );

  const syncDuration = (element: HTMLAudioElement) => {
    const measured = finiteDuration(element.duration);
    if (measured !== undefined) setDuration(measured);
  };

  return (
    <div className={styles.audioAttachment}>
      {/* biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL. */}
      <audio
        ref={audio}
        src={source}
        preload="metadata"
        onLoadedMetadata={(event) => syncDuration(event.currentTarget)}
        onDurationChange={(event) => syncDuration(event.currentTarget)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPlay={(event) => {
          if (playing && playing !== event.currentTarget) playing.pause();
          playing = event.currentTarget;
          setIsPlaying(true);
        }}
        onPause={(event) => {
          if (playing === event.currentTarget) playing = null;
          setIsPlaying(false);
        }}
        onError={(event) => {
          if (playing === event.currentTarget) playing = null;
          setFailedSource(source);
        }}
      />
      <button
        type="button"
        className={styles.audioPlay}
        aria-label={isPlaying ? "Pause audio" : "Play audio"}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play();
          else element.pause();
        }}
      >
        {isPlaying ? (
          <PauseIcon size={18} aria-hidden="true" />
        ) : (
          <PlayIcon size={18} aria-hidden="true" />
        )}
      </button>
      <input
        className={styles.audioSeek}
        type="range"
        aria-label="Seek audio"
        min={0}
        max={total ?? 0}
        step={1}
        value={total === undefined ? 0 : Math.min(currentTime, total)}
        disabled={total === undefined}
        aria-valuetext={formatMediaTime(currentTime)}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          const element = audio.current;
          if (element) element.currentTime = next;
          setCurrentTime(next);
        }}
      />
      <span className={styles.audioTime}>
        {total !== undefined
          ? `${formatMediaTime(currentTime)} / ${formatMediaTime(total)}`
          : formatMediaTime(currentTime)}
      </span>
    </div>
  );
}
