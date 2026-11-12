import { useRef } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Asks before a new call, which turns the microphone on and, in a voice
 * agent's DM, invites that agent. */
export function StartHuddleDialog({
  voiceAgent,
  onClose,
  onStart,
}: {
  /** The name of the agent the new call invites. */
  voiceAgent?: string | undefined;
  onClose(): void;
  onStart(): void;
}) {
  const proceed = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title="Start a huddle?"
      description={
        voiceAgent
          ? `Your microphone will turn on and ${voiceAgent} will join automatically.`
          : "Your microphone will turn on, and others in this conversation can join."
      }
      initialFocus={proceed}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            ref={proceed}
            variant="primary"
            onClick={() => {
              onClose();
              onStart();
            }}
          >
            Start huddle
          </Button>
        </>
      }
    />
  );
}
