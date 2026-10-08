import {
  BUBBLE_COLORS,
  messageButtonStyle,
} from "../shared/theme/bubble-color";
import { IconButton } from "../shared/design-system/ui/IconButton";
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
} from "../shared/design-system/icons";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { ThemePicker } from "../shared/design-system/ui/ThemePicker";
import { Button } from "../shared/design-system/ui/Button";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Appearance } from "../shared/theme/service";

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
        <SettingsGroup>
          <PreferenceRow
            title="Color mode"
            trailing={
              <ThemePicker
                value={preference}
                onValueChange={appearance.setMode}
              />
            }
          />
          <PreferenceRow
            title="Interface size"
            trailing={
              <fieldset
                aria-label="Interface size"
                className="m-0 flex min-w-0 flex-wrap items-center gap-3 border-0 p-0"
              >
                <Button
                  type="button"
                  size="sm"
                  aria-label="Decrease interface size"
                  disabled={fontScale <= 0.8}
                  onClick={() => appearance.setFontScale(fontScale - 0.1)}
                >
                  −
                </Button>
                <output
                  aria-label="Interface size"
                  className="text-body-sm tabular-nums"
                >
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
                  <IconButton
                    icon={<ArrowCounterClockwiseIcon aria-hidden="true" />}
                    title="Reset interface size"
                    size="sm"
                    type="button"
                    ref={resetRef}
                    aria-label="Reset interface size"
                    onClick={() => appearance.setFontScale(1)}
                  />
                )}
              </fieldset>
            }
          />
          <PreferenceRow
            title="Message color"
            subtitle="For your bubbles and send button on this device."
            trailing={(label) => (
              <fieldset
                {...label}
                className="m-0 grid min-w-0 grid-cols-5 gap-2 border-0 p-0"
              >
                {BUBBLE_COLORS.map((color) => (
                  <IconButton
                    key={color}
                    data-bubble-color={color}
                    style={messageButtonStyle}
                    variant="primary"
                    size="sm"
                    shape="round"
                    aria-label={`${color.charAt(0).toUpperCase()}${color.slice(1)} message color`}
                    title={`${color.charAt(0).toUpperCase()}${color.slice(1)}`}
                    aria-pressed={bubbleColor === color}
                    onClick={() => appearance.setBubbleColor(color)}
                    icon={
                      <CheckIcon
                        aria-hidden="true"
                        className={
                          bubbleColor === color ? "opacity-100" : "opacity-0"
                        }
                      />
                    }
                  />
                ))}
              </fieldset>
            )}
          />
        </SettingsGroup>
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
