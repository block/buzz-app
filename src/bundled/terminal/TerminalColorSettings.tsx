import { useRef, useSyncExternalStore } from "react";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { parseColorMode } from "../../shared/theme/service";
import {
  listSchemes,
  PALETTE_KEYS,
  parseAlacrittyScheme,
  resolveTerminalTheme,
  type TerminalThemePreference,
} from "./theme-preference";
import type { createTerminalSettingsDraft } from "./TerminalSettings";

const APPEARANCES = [
  { value: "system", label: "Match app" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

// The host writes the resolved app mode on the root; Match app follows it.
const readAppMode = () =>
  parseColorMode(document.documentElement.dataset.colorMode);
function subscribeAppMode(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-color-mode"],
  });
  return () => observer.disconnect();
}

export function TerminalColorSettings({
  colors,
  drafts,
  active,
}: {
  colors: TerminalThemePreference;
  drafts: ReturnType<typeof createTerminalSettingsDraft>;
  active(): boolean;
}) {
  const appMode = useSyncExternalStore(subscribeAppMode, readAppMode);
  const group = useRef<HTMLDivElement>(null);
  const preference = useSyncExternalStore(colors.subscribe, colors.snapshot);
  const { schemeName, schemeToml, schemeError } = useSyncExternalStore(
    drafts.subscribe,
    drafts.snapshot,
  );
  const entries = listSchemes(preference.imported);
  const { entry, mode, scheme } = resolveTerminalTheme(preference, appMode);
  const option = (name: string) => ({ value: name, label: name });
  const imported = entries.filter((item) => item.imported);
  // Buzz in an explicit appearance previews the scoped host roles.
  const scoped =
    !scheme && preference.appearance !== "system" ? mode : undefined;
  return (
    <>
      <InlineHeader title="Colors" />
      <div ref={group}>
        <SettingsGroup>
          <PreferenceRow
            title="Appearance"
            subtitle="Chooses the light or dark version of a color scheme."
            trailing={
              <Select
                variant="compact"
                label="Terminal appearance"
                value={preference.appearance}
                groups={[{ label: "Appearance", options: APPEARANCES }]}
                onValueChange={(value) => {
                  if (
                    value === "system" ||
                    value === "light" ||
                    value === "dark"
                  )
                    colors.setAppearance(value);
                }}
              />
            }
          />
          <PreferenceRow
            title="Color scheme"
            trailing={
              <Select
                variant="compact"
                label="Terminal color scheme"
                value={entry.name}
                groups={[
                  {
                    label: "Built in",
                    options: entries
                      .filter((item) => !item.imported)
                      .map(({ name }) => option(name)),
                  },
                  ...(imported.length
                    ? [
                        {
                          label: "Imported",
                          separator: true,
                          options: imported.map(({ name }) => option(name)),
                        },
                      ]
                    : []),
                ]}
                onValueChange={colors.setScheme}
              />
            }
          />
          {imported.map(({ name, light, dark }) => (
            <PreferenceRow
              key={name}
              title={name}
              subtitle={light === dark ? "Imported" : "Imported Light and Dark"}
              trailing={
                <Button
                  type="button"
                  size="sm"
                  variant="subtle"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    colors.remove(name);
                    // The row and its button go away; keep keyboard focus in the group.
                    group.current
                      ?.querySelector<HTMLElement>(
                        '[role="combobox"][aria-label="Terminal color scheme"]',
                      )
                      ?.focus();
                  }}
                >
                  Remove
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      </div>
      {/* Terminal colors are renderer-owned, so the preview paints them directly. */}
      <div
        role="img"
        aria-label={`Preview of ${entry.name}${entry.light === entry.dark ? "" : ` ${mode === "dark" ? "Dark" : "Light"}`}`}
        className={`my-4 flex flex-col gap-2 rounded-md p-3 text-mono ${scoped ?? ""}`}
        data-color-mode={scoped}
        style={{
          background: scheme?.background ?? "var(--surface-panel)",
          color: scheme?.foreground ?? "var(--text-standard)",
        }}
      >
        <span aria-hidden="true">~ $ echo hello</span>
        {scheme && (
          <span className="flex flex-wrap gap-1" aria-hidden="true">
            {PALETTE_KEYS.map((key) => (
              <span
                key={key}
                className="size-4 rounded-sm"
                style={{ background: scheme[key] }}
              />
            ))}
          </span>
        )}
      </div>
      <InlineHeader title="Import a color scheme" />
      <SettingsGroup layout="form">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            try {
              colors.importScheme(parseAlacrittyScheme(schemeName, schemeToml));
              drafts.update({
                schemeName: "",
                schemeToml: "",
                schemeError: null,
              });
            } catch (error) {
              drafts.update({
                schemeError:
                  error instanceof Error ? error.message : String(error),
              });
            }
          }}
        >
          <div className="flex flex-col gap-4">
            <Field
              label="Scheme name"
              description="Name a pair “<Name> Light” and “<Name> Dark” to follow Appearance."
            >
              <Input
                value={schemeName}
                onValueChange={(next) =>
                  drafts.update({ schemeName: next, schemeError: null })
                }
                placeholder="One Half Dark"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Alacritty colors"
              description="Paste the color tables of an Alacritty theme or config, in TOML."
              error={schemeError ?? undefined}
            >
              <Textarea
                variant="code"
                rows={6}
                value={schemeToml}
                onChange={(event) =>
                  drafts.update({
                    schemeToml: event.currentTarget.value,
                    schemeError: null,
                  })
                }
                placeholder={"[colors.primary]\nbackground = '#282c34'\n…"}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={!schemeName.trim() || !schemeToml.trim()}
            >
              Import
            </Button>
          </div>
        </form>
      </SettingsGroup>
      {active() && preference.error && (
        <ToastNotice
          title="Terminal color preference needs attention"
          description={preference.error}
        >
          <Button type="button" size="sm" onClick={colors.retry}>
            Retry terminal color preference
          </Button>
        </ToastNotice>
      )}
    </>
  );
}
