import { useEffect, useRef } from "react";
import type {
  ComposerTool,
  ComposerToolProps,
} from "../../features/conversation/contracts";
import { MicrophoneIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { VoiceCapture } from "./VoiceCapture";

function Recorder({ session, disabled, capture, focus }: ComposerToolProps) {
  // The capture the host mounts outlives this button's subtree; when the
  // contribution goes away (plugin disabled, tool list changed) the
  // recording it started is cancelled with it, releasing the microphone.
  const release = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      release.current?.();
      release.current = undefined;
    },
    [],
  );
  if (!session.attachments || !capture) return null;
  return (
    <IconButton
      type="button"
      size="sm"
      aria-label="Record voice note"
      title="Record voice note"
      disabled={disabled}
      onClick={() => {
        const started = capture(({ accept, cancel }) => (
          <VoiceCapture
            accept={(recording) => {
              const accepted = accept(recording);
              if (accepted) focus();
              return accepted;
            }}
            cancel={() => {
              cancel();
              focus();
            }}
          />
        ));
        if (started) release.current = started;
      }}
      icon={<MicrophoneIcon size={16} aria-hidden="true" />}
    />
  );
}

/** The composer's record button; main and pop-out windows share it. */
export const voiceRecorderTool: ComposerTool = {
  id: "recorder",
  title: "Voice Notes",
  order: 10,
  component: Recorder,
};
