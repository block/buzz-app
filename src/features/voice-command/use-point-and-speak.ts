import { useEffect, useRef, useState } from "react";
import { useMotionValue } from "motion/react";
import {
  useVoiceNoteRecorder,
  type VoiceNoteRecording,
} from "../../bundled/voice-notes/useVoiceNoteRecorder";
import { pointedTarget } from "./pointing-context";
import { pointedScreenshot, type PointingShot } from "./pointed-screenshot";

export function usePointAndSpeak(enabled: boolean) {
  const recorder = useVoiceNoteRecorder();
  const [review, setReview] = useState<{
    note: VoiceNoteRecording;
    screenshots: PointingShot[];
    captureError?: string | undefined;
  }>();
  const pointer = useMotionValue({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const [activeCapture, setActiveCapture] = useState(false);
  const [spotlight, setSpotlight] = useState<DOMRect>();
  const current = useRef({ recorder, review });
  current.current = { recorder, review };
  const finishRef = useRef<() => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let held = false,
      pending = false,
      origin = 0;
    let generation = 0;
    let processing = false;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let dwellTimer: ReturnType<typeof setTimeout> | undefined;
    let sampleFrame: number | undefined;
    let spotlightElement: HTMLElement | undefined;
    let point: { x: number; y: number } | undefined;
    let target: HTMLElement | undefined;
    let screenshots: PointingShot[] = [];
    let captured = new WeakSet<HTMLElement>();
    let screenshotPending: Promise<void> | undefined;
    let captureError: string | undefined;
    const elapsed = () => Math.max(0, performance.now() - origin);
    const clearTarget = () => {
      clearTimeout(dwellTimer);
      target = undefined;
    };
    const sample = () => {
      if (!point || (!held && !origin)) return;
      const element = pointedTarget(
        document.elementFromPoint(point.x, point.y),
      );
      spotlightElement = element;
      if (sampleFrame === undefined)
        sampleFrame = requestAnimationFrame(() => {
          sampleFrame = undefined;
          if (!held && !origin) return;
          const bounds = spotlightElement?.getBoundingClientRect();
          setSpotlight((previous) =>
            previous?.left === bounds?.left &&
            previous?.top === bounds?.top &&
            previous?.width === bounds?.width &&
            previous?.height === bounds?.height
              ? previous
              : bounds,
          );
        });
      if (!origin) return;
      if (target === element) return;
      clearTarget();
      if (!element || screenshots.length >= 4 || captured.has(element)) return;
      target = element;
      // A settled point earns a screenshot; crossing controls does not.
      dwellTimer = setTimeout(() => {
        if (!point || screenshotPending) return;
        captured.add(element);
        const atMs = elapsed();
        const capturing = generation;
        screenshotPending = pointedScreenshot(element, point, atMs)
          .then((shot) => {
            if (capturing === generation) screenshots.push(shot);
          })
          .catch(() => {
            if (capturing === generation)
              captureError =
                "A screenshot couldn’t be captured. Review any available images, or discard and record again.";
          })
          .finally(() => {
            screenshotPending = undefined;
            if (held && origin) {
              clearTarget();
              sample();
            }
          });
      }, 350);
    };
    const cancel = () => {
      setSpotlight(undefined);
      generation++;
      setActiveCapture(false);
      processing = false;
      held = pending = false;
      clearTimeout(holdTimer);
      clearTarget();
      origin = 0;
      current.current.recorder.cancel();
    };
    cancelRef.current = cancel;
    const finish = async () => {
      held = false;
      clearTimeout(holdTimer);
      if (!origin) {
        if (pending && !processing) cancel();
        else if (!processing) setActiveCapture(false);
        return;
      }
      clearTarget();
      origin = 0;
      const capturedShots = screenshots;
      setSpotlight(undefined);
      processing = true;
      const finishing = generation;
      const [note] = await Promise.all([
        current.current.recorder.stop(),
        screenshotPending,
      ]);
      if (!pending || finishing !== generation) return;
      processing = false;
      pending = false;
      setActiveCapture(false);
      if (note)
        setReview({
          note,
          screenshots: capturedShots.filter(
            (shot) => shot.atMs <= note.duration * 1000,
          ),
          captureError,
        });
    };
    finishRef.current = () => {
      void finish();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Meta" && event.key !== "Alt") {
        if (held || (event.key === "Escape" && pending)) cancel();
        return;
      }
      if (
        event.repeat ||
        held ||
        pending ||
        current.current.review ||
        !event.altKey ||
        !event.metaKey ||
        event.shiftKey ||
        event.ctrlKey ||
        Array.from(
          document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
        ).some(
          (element) =>
            element.getClientRects().length &&
            !element.closest('[inert], [aria-hidden="true"]'),
        )
      )
        return;
      held = true;
      pointer.set(
        point ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      );
      setActiveCapture(true);
      sample();
      holdTimer = setTimeout(async () => {
        if (!held) return;
        pending = true;
        const starting = ++generation;
        screenshots = [];
        captured = new WeakSet();
        captureError = undefined;
        await current.current.recorder.start();
        if (!held || !pending || starting !== generation) return;
        origin = current.current.recorder.startedAt() ?? 0;
        if (!origin) {
          pending = false;
          setActiveCapture(false);
          return;
        }
        sample();
      }, 250);
    };
    const keyup = (event: KeyboardEvent) => {
      if (
        (event.key === "Meta" || event.key === "Alt") &&
        (!event.metaKey || !event.altKey)
      )
        void finish();
    };
    const pointermove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      if (held || pending) pointer.set(point);
      sample();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", keyup, true);
    document.addEventListener("pointermove", pointermove, { passive: true });
    document.addEventListener("scroll", sample, true);
    window.addEventListener("resize", sample);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      if (sampleFrame !== undefined) cancelAnimationFrame(sampleFrame);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true);
      document.removeEventListener("pointermove", pointermove);
      document.removeEventListener("scroll", sample, true);
      window.removeEventListener("resize", sample);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", cancel);
    };
  }, [enabled, pointer]);
  useEffect(() => {
    if (recorder.error) cancelRef.current();
  }, [recorder.error]);
  useEffect(() => {
    if (recorder.status === "recording" && recorder.elapsedSeconds >= 300)
      finishRef.current();
  }, [recorder.status, recorder.elapsedSeconds]);
  return {
    recorder,
    review,
    setReview,
    pointer,
    activeCapture,
    spotlight,
    cancel: () => cancelRef.current(),
  };
}
