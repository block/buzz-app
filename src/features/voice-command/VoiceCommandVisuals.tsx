import { useId, useMemo } from "react";
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
  type MotionStyle,
} from "motion/react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Panel } from "../../shared/design-system/ui/Panel";
import { BestieIcon, XIcon } from "../../shared/design-system/icons";
import { PackedAgentAvatar } from "../agents/PackedAgentAvatar";
import { agentAvatars } from "../agents/avatar-packs";
import { VoiceNoteRecorder } from "../../bundled/voice-notes/VoiceNoteRecorder";
import { VoiceNoteCard } from "../../bundled/voice-notes/VoiceNoteCard";
import styles from "./VoiceCommand.module.css";

export type SpotlightRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** Pointer-transparent scrim with a genuinely clear opening, rather than a bright overlay. */
export function VoiceSpotlight({
  target,
  opacity = 0.05,
  padding = 8,
  radius = 18,
  softness = 11,
}: {
  target?: SpotlightRect | undefined;
  opacity?: number;
  padding?: number;
  radius?: number;
  softness?: number;
}) {
  const id = useId();
  return (
    <svg aria-hidden="true" className={styles.spotlight}>
      <defs>
        <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={softness} />
        </filter>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <rect width="100%" height="100%" fill="white" />
          {target && (
            <rect
              x={target.left - padding}
              y={target.top - padding}
              width={target.width + padding * 2}
              height={target.height + padding * 2}
              rx={radius}
              fill="black"
              filter={softness ? `url(#${id}-soft)` : undefined}
            />
          )}
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill="black"
        opacity={opacity}
        mask={`url(#${id})`}
      />
    </svg>
  );
}

export function VoiceCompanion({
  pointer,
  avatar,
  recording,
  energy = 0,
  viewport = { width: window.innerWidth, height: window.innerHeight },
  size = 64,
  auraBlur = 14,
  auraOpacity = 0.91,
  auraScale = 2.4,
  auraSaturation = 5.9,
  auraBrightness = 0.95,
  auraContrast = 1.3,
  auraHue = 0,
  reactivity = 0.7,
  offset = 24,
  followMs = 210,
  animated = true,
}: {
  pointer: MotionValue<{ x: number; y: number }>;
  avatar?: string | undefined;
  recording: boolean;
  energy?: number;
  viewport?: { width: number; height: number };
  size?: number;
  auraBlur?: number;
  auraOpacity?: number;
  auraScale?: number;
  auraSaturation?: number;
  auraBrightness?: number;
  auraContrast?: number;
  auraHue?: number;
  reactivity?: number;
  offset?: number;
  followMs?: number;
  animated?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const margin = Math.max(48, size * 1.25);
  const x = useTransform(pointer, (point) =>
    Math.max(margin, Math.min(viewport.width - margin, point.x)),
  );
  const y = useTransform(pointer, (point) =>
    Math.max(12, Math.min(viewport.height - size - 24, point.y + offset)),
  );
  const springX = useSpring(x, { duration: followMs / 1000, bounce: 0 });
  const springY = useSpring(y, { duration: followMs / 1000, bounce: 0 });
  const transform = useTransform(
    () =>
      `translate3d(${reducedMotion || !followMs ? x.get() : springX.get()}px, ${reducedMotion || !followMs ? y.get() : springY.get()}px, 0)`,
  );
  const pack = useMemo(
    () =>
      agentAvatars.find(
        (item) => item.url === avatar || item.preview === avatar,
      ),
    [avatar],
  );
  const artwork =
    pack && animated ? (
      <PackedAgentAvatar avatar={pack} />
    ) : (pack?.preview ?? avatar) ? (
      <img src={pack?.preview ?? avatar} alt="" />
    ) : (
      <BestieIcon />
    );
  return (
    <motion.div
      className={styles.companion}
      aria-hidden="true"
      data-recording={recording || undefined}
      style={
        {
          transform,
          "--voice-size": `${size}px`,
          "--voice-blur": `${auraBlur}px`,
          "--voice-aura-opacity": auraOpacity,
          "--voice-aura-saturation": auraSaturation,
          "--voice-aura-brightness": auraBrightness,
          "--voice-aura-contrast": auraContrast,
          "--voice-aura-hue": `${auraHue}deg`,
          "--voice-energy": auraScale + Math.min(1, energy) * reactivity,
        } as MotionStyle
      }
    >
      <div className={styles.cloud}>
        {pack?.preview || avatar ? (
          <img src={pack?.preview ?? avatar} alt="" />
        ) : (
          <BestieIcon />
        )}
      </div>
      <div className={styles.portrait}>{artwork}</div>
    </motion.div>
  );
}

export function VoiceRecordingBar({
  elapsedSeconds,
  levels,
  status,
  onCancel,
  width = 384,
  bottom = 24,
}: {
  elapsedSeconds: number;
  levels: readonly number[];
  status: "requesting" | "recording" | "processing";
  onCancel(): void;
  width?: number;
  bottom?: number;
}) {
  return (
    <div
      className={styles.hud}
      style={{ width: `min(${width}px, calc(100% - 32px))`, bottom }}
    >
      <Panel shape="capsule">
        <div className={styles.recording}>
          <VoiceNoteRecorder
            autoFocus={false}
            elapsedSeconds={elapsedSeconds}
            levels={levels}
            status={status}
            onCancel={onCancel}
          />
        </div>
      </Panel>
    </div>
  );
}

export function VoiceCommandReview({
  open,
  name,
  source,
  duration,
  waveform,
  error,
  sending,
  onClose,
  onSend,
  screenshots = [],
  onRemoveScreenshot,
  size = "default",
}: {
  open: boolean;
  name: string;
  source?: string | undefined;
  duration: number;
  waveform: readonly number[];
  error?: string | undefined;
  sending: boolean;
  onClose(): void;
  onSend(): void;
  screenshots?: readonly { source: string; atMs: number }[];
  onRemoveScreenshot?(index: number): void;
  size?: "compact" | "default" | "wide";
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={`Voice note to ${name}`}
      description="Review your voice note and screenshots before sending. Nothing is sent until you choose Send."
      preventClose={sending}
      size={size}
      actions={
        <>
          <Button disabled={sending} onClick={onClose}>
            Discard
          </Button>
          <Button
            variant="prominent"
            loading={sending}
            disabled={!source}
            onClick={onSend}
          >
            Send to Bestie
          </Button>
        </>
      }
    >
      <div className={styles.review}>
        {source && (
          <VoiceNoteCard
            source={source}
            duration={duration}
            waveform={waveform}
          />
        )}
        {screenshots.map((shot, i) => (
          <figure className={styles.screenshot} key={shot.source}>
            <img
              src={shot.source}
              alt={`Pointed-at UI at ${(shot.atMs / 1000).toFixed(2)} seconds`}
            />
            <figcaption className="text-caption text-subtle">
              Image {i + 1} · {(shot.atMs / 1000).toFixed(2)}s
              {onRemoveScreenshot && (
                <IconButton
                  icon={<XIcon />}
                  aria-label={`Remove image ${i + 1}`}
                  disabled={sending}
                  onClick={() => onRemoveScreenshot(i)}
                />
              )}
            </figcaption>
          </figure>
        ))}
        {error && (
          <p role="alert" className="text-body-sm">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
