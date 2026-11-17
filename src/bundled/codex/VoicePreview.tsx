import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  PlayIcon,
  StopIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import type { Spawn } from "./rpc";
import { previewVoice } from "./voice-preview";

const name = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

/** One playback owner for the settings control and its transient chooser. */
export function VoicePreview({
  spawn,
  voice,
  voices,
  defaultVoice,
  disabled,
  previewDisabled = false,
  onChange,
}: {
  spawn: Spawn;
  voice: string;
  voices?: string[] | undefined;
  defaultVoice?: string | undefined;
  disabled: boolean;
  previewDisabled?: boolean;
  onChange(voice: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState<{
    voice: string;
    abort: AbortController;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (disabled || previewDisabled) {
      playing?.abort.abort();
      setPlaying(undefined);
    }
  }, [playing, disabled, previewDisabled]);
  useEffect(() => {
    return () => {
      playing?.abort.abort();
    };
  }, [playing]);
  const stop = () => {
    playing?.abort.abort();
    setPlaying(undefined);
  };
  const play = async (sample: string) => {
    stop();
    if (playing?.voice === sample) return;
    const abort = new AbortController();
    setPlaying({ voice: sample, abort });
    setError("");
    try {
      await previewVoice(spawn, sample, abort.signal);
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Voice preview failed. Try again.",
        );
    } finally {
      setPlaying((current) => (current?.abort === abort ? undefined : current));
    }
  };
  const available = (value: string) =>
    !value || !voices || voices.includes(value);
  const defaultLabel = defaultVoice
    ? `Codex default (${name(defaultVoice)})`
    : "Codex default";
  const label = (value: string) =>
    value
      ? `${name(value)}${available(value) ? "" : " (unavailable)"}`
      : defaultLabel;
  const failure = error && (
    <p role="alert" className="buzz-field-error">
      {error}
    </p>
  );
  const preview = (value: string) => (
    <IconButton
      aria-label={
        playing?.voice === value
          ? `Stop preview of ${label(value)}`
          : `Preview ${label(value)}`
      }
      icon={playing?.voice === value ? <StopIcon /> : <PlayIcon />}
      disabled={disabled || previewDisabled || !available(value)}
      onClick={() => void play(value)}
    />
  );
  return (
    <>
      <PreferenceRow
        title="Huddle voice"
        trailing={(accessible) => (
          <div className="flex items-center gap-2">
            <Button
              {...accessible}
              ref={trigger}
              variant="ghost"
              disabled={disabled}
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            >
              {!voice && defaultVoice
                ? `${name(defaultVoice)} · Default`
                : label(voice)}
            </Button>
            <IconButton
              aria-label={playing ? "Stop preview" : "Preview voice"}
              icon={playing ? <StopIcon /> : <PlayIcon />}
              disabled={disabled || previewDisabled || !available(voice)}
              onClick={() => void play(voice)}
            />
          </div>
        )}
      />
      {!open && failure}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          stop();
          setOpen(next);
        }}
        title="Choose Huddle voice"
        size="compact"
        finalFocus={trigger}
      >
        <Field label="Voice" labelVisibility="hidden">
          <RadioGroup
            value={voice}
            onValueChange={(value) => {
              stop();
              onChange(value);
              setOpen(false);
            }}
            disabled={disabled}
          >
            {[
              "",
              ...(voice && !voices?.includes(voice) ? [voice] : []),
              ...(voices ?? []),
            ].map((value) => (
              <div key={value} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Radio
                    value={value}
                    variant="tile"
                    disabled={!available(value)}
                    label={
                      <span className="flex items-center gap-2">
                        {label(value)}
                        {voice === value && <CheckIcon aria-hidden="true" />}
                      </span>
                    }
                  />
                </div>
                {preview(value)}
              </div>
            ))}
          </RadioGroup>
        </Field>
        {failure}
      </Dialog>
    </>
  );
}
