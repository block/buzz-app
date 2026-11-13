import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RelaySession } from "../relay/session";
import { validateRecording } from "../relay/voice-media";
import type { UploadedAttachment } from "../relay/attachments";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { usePointAndSpeak } from "./use-point-and-speak";
import { screenshotSummary } from "./pointed-screenshot";
import styles from "./VoiceCommand.module.css";
import {
  VoiceSpotlight,
  VoiceCompanion,
  VoiceRecordingBar,
  VoiceCommandReview,
} from "./VoiceCommandVisuals";

/** One foreground-window capture; existing session upload and outbox own delivery. */
export function BestieVoiceCommand({
  session,
  channelId,
  name,
  agentId,
  avatar,
}: {
  session: RelaySession;
  channelId?: string | undefined;
  name: string;
  agentId: string;
  avatar?: string | undefined;
}) {
  const {
    recorder,
    review,
    setReview,
    cancel,
    pointer,
    activeCapture,
    spotlight,
  } = usePointAndSpeak(!!session.attachments);
  const [source, setSource] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [screenshots, setScreenshots] = useState<
    { source: string; atMs: number }[]
  >([]);
  const uploaded = useRef(new Map<File, UploadedAttachment>());
  const transfer = useRef<AbortController | undefined>(undefined);
  const destination = useRef(channelId);
  destination.current ??= channelId;
  const notify = useToastNotification();
  const report = useEffectEvent(notify);
  const note = review?.note;
  useEffect(() => {
    if (recorder.error) report(recorder.error, "error");
  }, [recorder.error]);
  useEffect(() => {
    uploaded.current.clear();
    setError(undefined);
    if (!note) {
      setSource(undefined);
      return;
    }
    const url = URL.createObjectURL(note.file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [note]);
  useEffect(() => {
    const images = (review?.screenshots ?? []).map((shot) => ({
      source: URL.createObjectURL(shot.file),
      atMs: shot.atMs,
    }));
    setScreenshots(images);
    return () => {
      for (const image of images) URL.revokeObjectURL(image.source);
    };
  }, [review?.screenshots]);
  useEffect(() => () => transfer.current?.abort(), []);

  async function send() {
    if (!review || transfer.current || !session.attachments) return;
    const controller = new AbortController();
    transfer.current = controller;
    setSending(true);
    setError(undefined);
    try {
      validateRecording(review.note);
      if (!destination.current) {
        if (
          !session.agentChoices
            .snapshot()
            .selectable.some((choice) => choice.pubkey === agentId)
        )
          throw new Error(
            "Your Bestie is no longer available. Choose a Bestie and try again.",
          );
        destination.current = await session.directMessages.open(
          [agentId],
          controller.signal,
        );
      }
      controller.signal.throwIfAborted();
      const destinationId = destination.current;
      const attachments: UploadedAttachment[] = [];
      for (const file of [
        review.note.file,
        ...review.screenshots.map((shot) => shot.file),
      ]) {
        let attachment = uploaded.current.get(file);
        if (!attachment) {
          attachment = await session.attachments.upload(
            file,
            destinationId,
            controller.signal,
          );
          if (file === review.note.file)
            attachment = {
              ...attachment,
              voice: {
                duration: review.note.duration,
                waveform: review.note.waveform.map((level) =>
                  Math.round(level * 100),
                ),
              },
            };
          uploaded.current.set(file, attachment);
        }
        controller.signal.throwIfAborted();
        attachments.push(attachment);
      }
      controller.signal.throwIfAborted();
      session.messages.send(
        destinationId,
        screenshotSummary(review.screenshots),
        [],
        attachments,
      );
      setReview(undefined);
      notify(`Voice note added to your conversation with ${name}.`, "success");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not send this voice note. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setSending(false);
      transfer.current = undefined;
    }
  }
  return createPortal(
    <div data-voice-command="" data-buzz-ui="" className={styles.layer}>
      {activeCapture && <VoiceSpotlight target={spotlight} />}
      {activeCapture && pointer && (
        <VoiceCompanion
          pointer={pointer}
          avatar={avatar}
          recording={recorder.status === "recording"}
          energy={recorder.levels.at(-1) ?? 0}
        />
      )}
      {activeCapture && recorder.status !== "idle" && (
        <VoiceRecordingBar
          elapsedSeconds={recorder.elapsedSeconds}
          levels={recorder.levels}
          status={recorder.status}
          onCancel={cancel}
        />
      )}
      <VoiceCommandReview
        open={!!review}
        name={name}
        source={source}
        duration={review?.note.duration ?? 0}
        waveform={review?.note.waveform ?? []}
        error={error ?? review?.captureError}
        screenshots={screenshots}
        onRemoveScreenshot={(index) => {
          if (review && !sending)
            setReview({
              ...review,
              screenshots: review.screenshots.filter((_, i) => i !== index),
            });
        }}
        sending={sending}
        onClose={() => setReview(undefined)}
        onSend={() => void send()}
      />
    </div>,
    document.body,
  );
}
