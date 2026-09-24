import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Button } from "../shared/design-system/ui/Button";
import { useSyncExternalStore } from "react";
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
  const { preference, error, fontScale, fontError } = useSyncExternalStore(
    appearance.subscribe,
    appearance.snapshot,
  );
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
          <legend className="mb-2 p-0 text-label-sm">Text size</legend>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              aria-label="Decrease text size"
              disabled={fontScale <= 0.8}
              onClick={() => appearance.setFontScale(fontScale - 0.1)}
            >
              −
            </Button>
            <output aria-label="Text size">
              {Math.round(fontScale * 100)}%
            </output>
            <Button
              type="button"
              size="sm"
              aria-label="Increase text size"
              disabled={fontScale >= 2}
              onClick={() => appearance.setFontScale(fontScale + 0.1)}
            >
              +
            </Button>
            {fontScale !== 1 && (
              <Button
                size="sm"
                type="button"
                onClick={() => appearance.setFontScale(1)}
              >
                Reset text size
              </Button>
            )}
          </div>
        </fieldset>
        {active && fontError && (
          <ToastNotice title="Text size wasn’t saved" description={fontError}>
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving text size
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
