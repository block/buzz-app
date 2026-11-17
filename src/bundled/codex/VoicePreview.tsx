import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  CircleNotchIcon,
  PlayIcon,
  StopIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import {
  previewVoice,
  preloadPreview,
  type PreviewHost,
} from "./voice-preview";

const name = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

/** One playback owner for the settings control and its transient chooser. */
export function VoicePreview({
  host,
  previews,
  voice,
  voices,
  defaultVoice,
  disabled,
  previewDisabled = false,
  onChange,
  onShown,
}: {
  host?: PreviewHost | undefined;
  previews?: Record<string, string> | undefined;
  voice: string;
  voices?: string[] | undefined;
  defaultVoice?: string | undefined;
  disabled: boolean;
  previewDisabled?: boolean;
  onChange(voice: string): void;
  onShown?(): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState<{
    voice: string;
    abort: AbortController;
    loading: boolean;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (disabled || previewDisabled) return;
    const selected = previews?.[voice || defaultVoice || ""];
    if (selected) void preloadPreview(host, selected).catch(() => {});
    if (open)
      for (const choice of voices ?? []) {
        const url = previews?.[choice];
        if (url) void preloadPreview(host, url).catch(() => {});
      }
  }, [
    host,
    previews,
    voice,
    defaultVoice,
    voices,
    open,
    disabled,
    previewDisabled,
  ]);
  useEffect(() => {
    if (disabled || previewDisabled) {
      playing?.abort.abort();
      setPlaying(undefined);
    }
  }, [playing, disabled, previewDisabled]);
  const playback = playing?.abort;
  useEffect(() => () => playback?.abort(), [playback]);
  const visibilityChanged = useEffectEvent((visible: boolean) => {
    if (visible) onShown?.();
    else {
      playback?.abort();
      setPlaying(undefined);
      setOpen(false);
    }
  });
  useEffect(() => {
    const ancestors: HTMLElement[] = [];
    for (
      let element: HTMLElement | null = trigger.current;
      element;
      element = element.parentElement
    )
      ancestors.push(element);
    const isVisible = () =>
      !document.hidden &&
      (trigger.current?.checkVisibility?.({ visibilityProperty: true }) ??
        ancestors.every((element) => {
          const style = getComputedStyle(element);
          return (
            !element.hidden &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse"
          );
        }));
    let visible = isVisible();
    const check = () => {
      const next = isVisible();
      if (next !== visible) {
        visible = next;
        visibilityChanged(next);
      }
    };
    const observer = new MutationObserver(check);
    for (const element of ancestors)
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["hidden", "class", "style", "inert"],
      });
    document.addEventListener("visibilitychange", check);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  const stop = () => {
    playing?.abort.abort();
    setPlaying(undefined);
  };
  const play = async (sample: string) => {
    stop();
    if (playing?.voice === sample) return;
    const abort = new AbortController();
    setPlaying({ voice: sample, abort, loading: true });
    setError("");
    try {
      await previewVoice(
        host,
        previews?.[sample || defaultVoice || ""] ?? "",
        abort.signal,
        () =>
          setPlaying((current) =>
            current?.abort === abort ? { ...current, loading: false } : current,
          ),
      );
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
          ? `${playing.loading ? "Cancel loading" : "Stop"} preview of ${label(value)}`
          : `Preview ${label(value)}`
      }
      aria-busy={playing?.voice === value && playing.loading}
      icon={
        playing?.voice === value ? (
          playing.loading ? (
            <CircleNotchIcon className="motion-safe:animate-spin" />
          ) : (
            <StopIcon />
          )
        ) : (
          <PlayIcon />
        )
      }
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
              aria-label={
                playing
                  ? playing.loading
                    ? "Cancel loading preview"
                    : "Stop preview"
                  : "Preview voice"
              }
              aria-busy={playing?.loading}
              icon={
                playing ? (
                  playing.loading ? (
                    <CircleNotchIcon className="motion-safe:animate-spin" />
                  ) : (
                    <StopIcon />
                  )
                ) : (
                  <PlayIcon />
                )
              }
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
        headerGap="compact"
        footerGap="none"
        finalFocus={trigger}
      >
        <Field label="Voice" labelVisibility="hidden">
          <RadioGroup
            size="sm"
            value={voice}
            onValueChange={(value) => {
              stop();
              onChange(value);
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
                    variant="row"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.click();
                      }
                    }}
                    onClick={() => {
                      stop();
                      setOpen(false);
                    }}
                    disabled={!available(value)}
                    label={label(value)}
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
