import {
  BUBBLE_COLORS,
  messageButtonStyle,
} from "../shared/theme/bubble-color";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Button } from "../shared/design-system/ui/Button";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "../shared/design-system/icons/index";
import type { Appearance } from "../shared/theme/service";

/** Shared radios provide one Tab stop and standard arrow-key selection. */
export function AppearanceSettings({
  appearance,
  active = true,
}: {
  appearance: Appearance;
  active?: boolean;
}) {
  const increaseButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const resetRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node)
        pendingFocus.current = increaseButton.current;
    };
  }, []);
  useLayoutEffect(() => {
    // At 200%, Increase is still disabled during Reset's ref cleanup.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const { preference, error, fontScale, fontError, bubbleColor, bubbleError } =
    useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  return (
    <section aria-labelledby="appearance-settings-title">
      <Header id="appearance-settings-title" title="Appearance" />
      <div>
        <Field label="Color mode">
          <RadioGroup
            name="color-mode"
            value={preference}
            onValueChange={(value) => appearance.setMode(value)}
          >
            {(
              [
                ["light", "Light", SunIcon],
                ["dark", "Dark", MoonIcon],
                ["system", "System", MonitorIcon],
              ] as const
            ).map(([value, label, Icon]) => (
              <Radio
                key={value}
                value={value}
                variant="card"
                label={
                  <span className="flex items-center gap-3">
                    <Icon size={20} aria-hidden="true" />
                    {label}
                  </span>
                }
              />
            ))}
          </RadioGroup>
        </Field>
        <fieldset className="m-0 mt-6 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 text-label-sm">Your message color</legend>
          <p className="mb-3 text-body-sm text-subtle">
            Used for your message bubbles and the send button on this device.
          </p>
          <div className="flex flex-wrap gap-2">
            {BUBBLE_COLORS.map((color) => (
              <IconButton
                key={color}
                data-bubble-color={color}
                style={messageButtonStyle}
                variant="primary"
                size="large"
                shape="round"
                aria-label={`${color.charAt(0).toUpperCase()}${color.slice(1)} message color`}
                title={`${color.charAt(0).toUpperCase()}${color.slice(1)}`}
                aria-pressed={bubbleColor === color}
                onClick={() => appearance.setBubbleColor(color)}
                icon={
                  <span
                    className={
                      bubbleColor === color
                        ? "size-6 rounded-full border-2 border-current"
                        : "size-6"
                    }
                    aria-hidden="true"
                  />
                }
              />
            ))}
          </div>
        </fieldset>
        {active && bubbleError && (
          <ToastNotice
            title="Message color wasn’t saved"
            description={bubbleError}
          >
            <Button
              size="sm"
              onClick={() => appearance.setBubbleColor(bubbleColor)}
            >
              Retry saving message color
            </Button>
          </ToastNotice>
        )}
        <fieldset className="m-0 mt-6 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 text-label-sm">Interface size</legend>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              aria-label="Decrease interface size"
              disabled={fontScale <= 0.8}
              onClick={() => appearance.setFontScale(fontScale - 0.1)}
            >
              −
            </Button>
            <output aria-label="Interface size" className="text-body-sm">
              {Math.round(fontScale * 100)}%
            </output>
            <Button
              type="button"
              size="sm"
              ref={increaseButton}
              aria-label="Increase interface size"
              disabled={fontScale >= 2}
              onClick={() => appearance.setFontScale(fontScale + 0.1)}
            >
              +
            </Button>
            {fontScale !== 1 && (
              <Button
                size="sm"
                type="button"
                ref={resetRef}
                aria-label="Reset interface size"
                onClick={() => appearance.setFontScale(1)}
              >
                Reset
              </Button>
            )}
          </div>
        </fieldset>
        {active && fontError && (
          <ToastNotice
            title="Interface size wasn’t saved"
            description={fontError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving interface size
            </Button>
          </ToastNotice>
        )}
        {active && error && (
          <ToastNotice title="Appearance wasn’t saved" description={error}>
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setMode(preference)}
            >
              Retry saving appearance
            </Button>
          </ToastNotice>
        )}
      </div>
    </section>
  );
}
