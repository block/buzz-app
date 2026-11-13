import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
} from "react";
import { useMotionValue } from "motion/react";
import {
  VoiceSpotlight,
  VoiceCompanion,
  VoiceRecordingBar,
  VoiceCommandReview,
  type SpotlightRect,
} from "../../../src/features/voice-command/VoiceCommandVisuals";
import { pointedTarget } from "../../../src/features/voice-command/pointing-context";
import visualStyles from "../../../src/features/voice-command/VoiceCommand.module.css";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../src/shared/design-system/ui/IconButton";
import { PanelHeader } from "../../../src/shared/design-system/ui/PanelHeader";
import { Avatar } from "../../../src/shared/design-system/ui/Avatar";
import {
  DotsThreeIcon,
  PlusIcon,
} from "../../../src/shared/design-system/icons";
import { MessageListRow } from "../../../src/features/messages/MessageListRow";
import { encodeVoiceNoteWav } from "../../../src/bundled/voice-notes/voiceNoteWav";

export type SceneKind =
  | "spotlight"
  | "companion"
  | "recorder"
  | "review"
  | "experience";
export type SceneTuning = {
  spotlight?: Omit<ComponentProps<typeof VoiceSpotlight>, "target">;
  companion?: Partial<
    Omit<ComponentProps<typeof VoiceCompanion>, "pointer" | "viewport">
  >;
  recorder?: { width: number; bottom: number; amplitude: number };
  review?: {
    size: "compact" | "default" | "wide";
    name: string;
    failSend: boolean;
  };
  holdMs?: number;
};
const bytes = encodeVoiceNoteWav(
  [Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 24) * 0.06)],
  24000,
);
const audio = URL.createObjectURL(
  new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
);
if (import.meta.hot) import.meta.hot.dispose(() => URL.revokeObjectURL(audio));
const initialLevels = Array.from(
  { length: 96 },
  (_, i) => 0.08 + Math.sin(i * 0.7) ** 2 * 0.6,
);

/** UI-only simulation. Uses real feature visuals; no session, microphone, signing or network writes. */
export function Scene({
  kind,
  variant,
  tuning = {},
  flow = false,
}: {
  kind: SceneKind;
  variant: string;
  tuning?: SceneTuning;
  flow?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLParagraphElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState({ width: 640, height: 500 });
  const pointer = useMotionValue({ x: 330, y: 210 });
  const [target, setTarget] = useState<SpotlightRect>();
  const [phase, setPhase] = useState(
    flow || kind === "review"
      ? "idle"
      : variant === "idle"
        ? "armed"
        : kind === "recorder"
          ? variant
          : "recording",
  );
  const [elapsed, setElapsed] = useState(4.2);
  const [levels, setLevels] = useState(initialLevels);
  const [selected, setSelected] = useState("Rowan");
  const [cancelled, setCancelled] = useState(false);
  const [shotTimes, setShotTimes] = useState([350, 750]);
  const holding = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const localRect = useCallback(
    (element: Element): SpotlightRect | undefined => {
      const parent = root.current?.getBoundingClientRect();
      if (!parent) return;
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left - parent.left,
        top: bounds.top - parent.top,
        width: bounds.width,
        height: bounds.height,
      };
    },
    [],
  );
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const resize = () => {
      const bounds = node.getBoundingClientRect();
      setViewport({ width: bounds.width, height: bounds.height });
      const chosen = variant === "control" ? control.current : first.current;
      if (chosen) setTarget(localRect(chosen));
      pointer.set({ x: bounds.width * 0.56, y: 225 });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [variant, localRect, pointer]);
  useEffect(() => {
    if (phase !== "recording") return;
    let sample = 0;
    const timer = setInterval(() => {
      sample++;
      setLevels((previous) => [
        ...previous.slice(-95),
        0.08 +
          Math.sin(sample * 0.7) ** 2 * (tuning.recorder?.amplitude ?? 0.6),
      ]);
      setElapsed((previous) => previous + 0.12);
    }, 120);
    return () => clearInterval(timer);
  }, [phase, tuning.recorder?.amplitude]);
  useEffect(() => {
    if (phase !== "sending") return;
    const timer = setTimeout(
      () => setPhase(tuning.review?.failSend ? "error" : "sent"),
      900,
    );
    return () => clearTimeout(timer);
  }, [phase, tuning.review?.failSend]);
  useEffect(() => {
    if (!flow) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(holding.current);
        setPhase("idle");
        return;
      }
      if (
        (event.key === "Meta" || event.key === "Alt") &&
        event.metaKey &&
        event.altKey &&
        !event.repeat &&
        root.current?.matches(":hover")
      ) {
        setPhase("armed");
        holding.current = setTimeout(() => {
          setElapsed(0);
          setPhase("recording");
        }, tuning.holdMs ?? 250);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== "Meta" && event.key !== "Alt") return;
      clearTimeout(holding.current);
      setPhase((previous) =>
        previous === "recording"
          ? "review"
          : previous === "armed"
            ? "idle"
            : previous,
      );
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => {
      clearTimeout(holding.current);
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
    };
  }, [flow, tuning.holdMs]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.getBoundingClientRect();
    pointer.set({
      x: event.clientX - parent.left,
      y: event.clientY - parent.top,
    });
    const pointed = pointedTarget(
      document.elementFromPoint(event.clientX, event.clientY),
    );
    setTarget(
      pointed && root.current?.contains(pointed)
        ? localRect(pointed)
        : undefined,
    );
  };
  const active =
    ["armed", "recording", "requesting", "processing"].includes(phase) &&
    !cancelled;
  const reviewOpen = ["review", "error", "sending"].includes(phase);
  const showReview = () => {
    setShotTimes([350, 750]);
    setPhase(
      variant === "sending"
        ? "sending"
        : variant === "error"
          ? "error"
          : "review",
    );
  };
  return (
    <div className="vc-scene" ref={root} onPointerMove={move}>
      <PanelHeader
        title={kind === "experience" ? "Voice & point" : "Team"}
        actions={
          <IconButton
            ref={control}
            variant="glass"
            aria-label="New message"
            icon={<PlusIcon />}
            onClick={() => setSelected("Sage")}
          />
        }
      />
      <div className="vc-fixture">
        <div className="vc-list">
          {["Rowan", "Sage", "Jordan"].map((name) => (
            <MessageListRow
              key={name}
              selected={name === selected}
              onClick={() => setSelected(name)}
              avatar={<Avatar size="fill" alt="" fallback={name} />}
              sender={name}
              source={null}
              time="now"
              preview={
                name === "Rowan"
                  ? "A little more room to breathe."
                  : "An update on the design."
              }
            />
          ))}
        </div>
        <section
          className="vc-chat"
          aria-label={`Conversation with ${selected}`}
        >
          <div className="vc-chat-heading">
            <Avatar alt="" fallback={selected} size="small" />
            <strong className="text-label-sm">{selected}</strong>
            <IconButton
              aria-label="Conversation actions"
              icon={<DotsThreeIcon />}
            />
          </div>
          <p
            ref={first}
            className="vc-message text-body-sm"
            data-message-id="fixture-message"
            data-channel-id="fixture-channel"
          >
            Could we make this feel a little lighter? The actions could use more
            breathing room.
          </p>
          <p className="vc-message vc-message-own text-body-sm">
            Point at anything here as you talk. The spotlight follows the
            element, while Bestie follows your pointer.
          </p>
          <p className="text-caption text-subtle">Today · design review</p>
        </section>
      </div>
      <div className="vc-demo-controls" data-voice-command="">
        {kind === "review" ? (
          <Button size="sm" onClick={showReview}>
            Open {variant} review
          </Button>
        ) : flow ? (
          <>
            <Button
              size="sm"
              variant="prominent"
              onClick={() => {
                setCancelled(false);
                setElapsed(0);
                setShotTimes([350, 750]);
                setPhase("recording");
              }}
            >
              {active ? "Restart demo" : "Start demo"}
            </Button>
            <Button
              size="sm"
              disabled={!active}
              onClick={() => setPhase("review")}
            >
              Finish & review
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setCancelled(false);
              setPhase(kind === "recorder" ? variant : "recording");
            }}
          >
            Replay fixture
          </Button>
        )}
        <span className="text-caption text-subtle">
          {phase === "sent"
            ? "Demo sent locally"
            : cancelled
              ? "Discarded"
              : "Simulated · no microphone or live sends"}
        </span>
      </div>
      <div className={visualStyles.layer} data-voice-command="">
        {active && ["spotlight", "experience"].includes(kind) && (
          <VoiceSpotlight
            {...tuning.spotlight}
            target={variant === "none" ? undefined : target}
          />
        )}
        {active && ["companion", "experience"].includes(kind) && (
          <VoiceCompanion
            {...tuning.companion}
            viewport={viewport}
            pointer={pointer}
            recording={phase === "recording"}
            energy={variant === "loud" ? 1 : (levels.at(-1) ?? 0.4)}
          />
        )}
        {active &&
          ["recorder", "experience"].includes(kind) &&
          phase !== "armed" && (
            <VoiceRecordingBar
              width={tuning.recorder?.width ?? 384}
              bottom={tuning.recorder?.bottom ?? 72}
              elapsedSeconds={elapsed}
              levels={levels}
              status={
                phase === "requesting"
                  ? "requesting"
                  : phase === "processing"
                    ? "processing"
                    : "recording"
              }
              onCancel={() => {
                setCancelled(true);
                setPhase("idle");
              }}
            />
          )}
      </div>
      <VoiceCommandReview
        open={reviewOpen}
        source={audio}
        duration={2}
        waveform={initialLevels.slice(0, 48)}
        screenshots={shotTimes.map((atMs) => ({
          atMs,
          source: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" rx="16" fill="#f5f5f3"/><text x="24" y="40" font-family="sans-serif" font-size="16" fill="#777">Simulated screenshot · ${(atMs / 1000).toFixed(2)}s</text><circle cx="48" cy="100" r="24" fill="#ddd"/><text x="88" y="92" font-family="sans-serif" font-size="18">${selected}</text><rect x="88" y="110" width="520" height="100" rx="20" fill="#e5e5e3"/><text x="108" y="148" font-family="sans-serif" font-size="18">Could we make this feel a little lighter?</text><text x="108" y="180" font-family="sans-serif" font-size="18">The actions could use more breathing room.</text></svg>`)}`,
        }))}
        onRemoveScreenshot={(index) =>
          setShotTimes((shots) => shots.filter((_, i) => i !== index))
        }
        name={tuning.review?.name ?? "Bestie"}
        size={tuning.review?.size ?? "default"}
        error={
          phase === "error"
            ? "Simulated upload error. Try again, or discard to adjust “Fail send” in the inspector."
            : undefined
        }
        sending={phase === "sending"}
        onClose={() => setPhase("idle")}
        onSend={() => setPhase("sending")}
      />
    </div>
  );
}
