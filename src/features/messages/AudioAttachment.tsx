import { useCallback, useRef, useState } from "react";
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
  const playLabel = attachment.name ? `Play ${attachment.name}` : "Play audio";
  const pauseLabel = attachment.name
    ? `Pause ${attachment.name}`
    : "Pause audio";
  const seekLabel = attachment.name ? `Seek ${attachment.name}` : "Seek audio";
  const valueText =
    duration !== undefined
      ? `${formatMediaTime(currentTime)} of ${formatMediaTime(duration)}`
      : formatMediaTime(currentTime);

  const setAudio = useCallback((element: HTMLAudioElement | null) => {
    // Callback refs are required because React detaches refs before passive effect cleanup, so cleanup cannot clear the module playback singleton.
    if (playing === audio.current) playing = null;
    audio.current = element;
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
        ref={setAudio}
        src={source}
        preload="metadata"
        onLoadedMetadata={(event) => syncDuration(event.currentTarget)}
        onDurationChange={(event) => syncDuration(event.currentTarget)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPlay={(event) => {
          // Set the singleton after pausing the previous element so exclusivity is correct for both synchronous jsdom and asynchronous browser pause events.
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
        aria-label={isPlaying ? pauseLabel : playLabel}
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
        aria-label={seekLabel}
        min={0}
        max={duration ?? 0}
        step={1}
        value={duration === undefined ? 0 : Math.min(currentTime, duration)}
        disabled={duration === undefined}
        aria-valuetext={valueText}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          const element = audio.current;
          if (element) element.currentTime = next;
          setCurrentTime(next);
        }}
      />
      <span className={styles.audioTime}>
        {duration !== undefined
          ? `${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`
          : formatMediaTime(currentTime)}
      </span>
    </div>
  );
}
