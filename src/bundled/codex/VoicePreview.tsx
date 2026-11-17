import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Select } from "../../shared/design-system/ui/Select";
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
  accents,
  voice,
  voices,
  defaultVoice,
  disabled,
  previewDisabled = false,
  previewLoading = false,
  onChange,
  onShown,
}: {
  host?: PreviewHost | undefined;
  previews?: Record<string, string> | undefined;
  accents?: Record<string, string> | undefined;
  voice: string;
  voices?: string[] | undefined;
  defaultVoice?: string | undefined;
  disabled: boolean;
  previewDisabled?: boolean;
  previewLoading?: boolean;
  onChange(voice: string): void | Promise<void>;
  onShown?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState<{
    voice: string;
    abort: AbortController;
    loading: boolean;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (disabled || previewDisabled || previewLoading) return;
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
    previewLoading,
  ]);
  useEffect(() => {
    if (disabled || previewDisabled || previewLoading) {
      playing?.abort.abort();
      setPlaying(undefined);
    }
  }, [playing, disabled, previewDisabled, previewLoading]);
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
    if (previewDisabled || previewLoading) return;
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
  const select = async (value: string) => {
    stop();
    setError("");
    try {
      await onChange(value);
      if (trigger.current?.getAttribute("aria-expanded") === "true")
        void play(value);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save voice. Try again.",
      );
    }
  };
  const row = (value: string) => (
    <Radio
      key={value}
      value={value}
      variant="row"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      onClick={() => {
        if (value === voice) void select(value);
      }}
      disabled={!available(value)}
      label={label(value)}
    />
  );
  const groups = new Map<string, string[]>();
  for (const value of [
    ...(voice && !voices?.includes(voice) ? [voice] : []),
    ...(voices ?? []),
  ]) {
    const accent = accents?.[value] ?? "Other voices";
    groups.set(accent, [...(groups.get(accent) ?? []), value]);
  }
  const locales = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const selectedLocale =
    accents?.[voice || defaultVoice || ""] ?? "Other voices";
  const shownLocale =
    locale && groups.has(locale)
      ? locale
      : groups.has(selectedLocale)
        ? selectedLocale
        : (locales[0] ?? "");
  return (
    <>
      <PreferenceRow
        title="Voice"
        trailing={(accessible) => (
          <Button
            {...accessible}
            ref={trigger}
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setLocale(undefined);
              setOpen(true);
            }}
          >
            {!voice && defaultVoice
              ? `${name(defaultVoice)} · Default`
              : label(voice)}
            <CaretDownIcon size={14} aria-hidden="true" />
          </Button>
        )}
      />
      {!open && failure}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          stop();
          setOpen(next);
        }}
        title="Choose voice"
        size="compact"
        headerGap="compact"
        footerGap="none"
        finalFocus={trigger}
      >
        <div className="grid gap-3">
          {!!locales.length && (
            <Select
              label="Language and region"
              variant="field"
              disabled={disabled}
              value={shownLocale}
              groups={[
                {
                  label: "",
                  options: locales.map((value) => ({ value, label: value })),
                },
              ]}
              onValueChange={(value) => {
                stop();
                setLocale(value);
              }}
            />
          )}
          <Field label="Voice" labelVisibility="hidden">
            <RadioGroup
              size="sm"
              value={voice}
              onValueChange={(value) => void select(value)}
              disabled={disabled}
            >
              {row("")}
              {(groups.get(shownLocale) ?? []).map(row)}
            </RadioGroup>
          </Field>
          {(previewLoading || playing) && (
            <p role="status" className="m-0 text-body-sm text-subtle">
              {previewLoading
                ? "Loading voice samples…"
                : playing?.loading
                  ? "Loading preview…"
                  : "Playing preview…"}
            </p>
          )}
          {failure}
        </div>
      </Dialog>
    </>
  );
}
