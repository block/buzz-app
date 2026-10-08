import { claimAudio, releaseAudio } from "../../shared/audio-playback";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { PauseIcon, PlayIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MAX_ATTACHMENT_DURATION_SECONDS,
  type Attachment,
} from "../relay/contracts";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";
import { useMediaElementSource } from "./use-media-element-source";

const ENDED_DURATION_CORRECTION_MIN_SECONDS = 0.05;
// Old Buzz voice notes include a 1 fps 16x16 video track, so container
// duration can overshoot the real audio by about one frame; allow headroom.
const ENDED_DURATION_CORRECTION_MAX_SECONDS = 1.5;

function finiteDuration(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_ATTACHMENT_DURATION_SECONDS
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
  const active = useConversationPresentation();
  const audio = useRef<HTMLAudioElement>(null);
  useLayoutEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  const endedDuration = useRef<number | undefined>(undefined);
  const previousSource = useRef(source);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() =>
    finiteDuration(attachment.duration),
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const element = useMediaElementSource(source);
  const elementSource = element.src;
  const failed = failedSource === source || element.unavailable;
  const playLabel = attachment.name ? `Play ${attachment.name}` : "Play audio";
  const pauseLabel = attachment.name
    ? `Pause ${attachment.name}`
    : "Pause audio";
  const seekLabel = attachment.name ? `Seek ${attachment.name}` : "Seek audio";
  const valueText =
    duration !== undefined
      ? `${formatMediaTime(currentTime)} of ${formatMediaTime(duration)}`
      : formatMediaTime(currentTime);
  const seekValue =
    duration === undefined ? 0 : Math.min(currentTime, duration);
  const seekProgress = duration ? (seekValue / duration) * 100 : 0;

  const setAudio = useCallback((element: HTMLAudioElement | null) => {
    // Callback refs are required because React detaches refs before passive effect cleanup, so cleanup cannot release playback ownership.
    releaseAudio(audio.current);
    audio.current = element;
  }, []);

  if (previousSource.current !== source) {
    previousSource.current = source;
    endedDuration.current = undefined;
    setCurrentTime(0);
    setDuration(finiteDuration(attachment.duration));
    setIsPlaying(false);
  }

  if (failed)
    return (
      <span
        className={`${styles.attachmentUnavailable} ${styles.audioUnavailable}`}
        role="status"
      >
        Audio unavailable
      </span>
    );

  const syncDuration = (element: HTMLAudioElement) => {
    const measured = finiteDuration(element.duration);
    if (measured === undefined) return;
    const corrected = endedDuration.current;
    if (
      corrected !== undefined &&
      measured > corrected + ENDED_DURATION_CORRECTION_MIN_SECONDS
    ) {
      setDuration(corrected);
      return;
    }
    setDuration(measured);
  };

  return (
    <div className={styles.audioAttachment}>
      {/* biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL. */}
      <audio
        ref={setAudio}
        src={elementSource}
        preload="metadata"
        onLoadedMetadata={(event) => syncDuration(event.currentTarget)}
        onDurationChange={(event) => syncDuration(event.currentTarget)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPlay={(event) => {
          claimAudio(event.currentTarget);
          setCurrentTime(event.currentTarget.currentTime);
          setIsPlaying(true);
        }}
        onPause={(event) => {
          releaseAudio(event.currentTarget);
          setIsPlaying(false);
        }}
        onEnded={(event) => {
          const measured = finiteDuration(event.currentTarget.currentTime);
          const durationGap =
            measured !== undefined && duration !== undefined
              ? duration - measured
              : undefined;
          const shouldCorrectDuration =
            endedDuration.current === undefined &&
            measured !== undefined &&
            durationGap !== undefined &&
            durationGap > ENDED_DURATION_CORRECTION_MIN_SECONDS &&
            durationGap <= ENDED_DURATION_CORRECTION_MAX_SECONDS;
          const nextDuration = shouldCorrectDuration
            ? measured
            : (duration ?? measured);
          if (shouldCorrectDuration) {
            endedDuration.current = measured;
            setDuration(measured);
          }
          if (nextDuration !== undefined) setCurrentTime(nextDuration);
          releaseAudio(event.currentTarget);
          setIsPlaying(false);
        }}
        onError={(event) => {
          releaseAudio(event.currentTarget);
          setFailedSource(source);
        }}
      />
      <IconButton
        size="compact"
        variant="solid"
        shape="round"
        type="button"
        aria-label={isPlaying ? pauseLabel : playLabel}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play().catch(() => {});
          else element.pause();
        }}
        icon={isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      />
      <input
        className={styles.audioSeek}
        style={{ "--audio-progress": `${seekProgress}%` } as CSSProperties}
        type="range"
        aria-label={seekLabel}
        min={0}
        max={duration ?? 0}
        step="any"
        value={seekValue}
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
