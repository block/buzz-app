import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { Spawn } from "./rpc";
import { previewVoice } from "./voice-preview";

export function VoicePreview({
  spawn,
  voice,
  disabled,
}: {
  spawn: Spawn;
  voice: string;
  disabled: boolean;
}) {
  const [playing, setPlaying] = useState<AbortController>();
  const [error, setError] = useState("");
  useEffect(() => () => playing?.abort(), [playing]);
  useEffect(() => {
    if (disabled) playing?.abort();
  }, [playing, disabled]);
  const play = async () => {
    if (playing) {
      playing.abort();
      setPlaying(undefined);
      return;
    }
    const abort = new AbortController();
    setPlaying(abort);
    setError("");
    try {
      await previewVoice(spawn, voice, abort.signal);
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Voice preview failed. Try again.",
        );
    } finally {
      setPlaying((current) => (current === abort ? undefined : current));
    }
  };
  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="ghost" disabled={disabled} onClick={() => void play()}>
        {playing ? "Stop preview" : "Preview voice"}
      </Button>
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
