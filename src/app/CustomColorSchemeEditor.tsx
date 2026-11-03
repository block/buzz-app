import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import {
  CUSTOM_SCHEME_COLORS,
  DEFAULT_CUSTOM_SCHEME,
  customSchemeStyle,
  normalizeHexColor,
  type CustomScheme,
  type CustomSchemeColor,
} from "../shared/theme/custom-scheme";

const LABELS: Record<CustomSchemeColor, string> = {
  app: "App background",
  panel: "Panel background",
  inset: "Inset background",
  popover: "Popover background",
  text: "Primary text",
  subtleText: "Secondary text",
  border: "Borders",
  accent: "Accent",
  accentText: "Text on accent",
  message: "Message bubble",
  ownMessage: "Your message bubble",
};

const DESCRIPTIONS: Record<CustomSchemeColor, string> = {
  app: "Shell and page canvas.",
  panel: "Settings, panes, and main surfaces.",
  inset: "Quiet controls and grouped areas.",
  popover: "Menus, popovers, and raised surfaces.",
  text: "Primary readable text.",
  subtleText: "Secondary labels and metadata.",
  border: "Dividers and field outlines.",
  accent: "Selected rows, send, mentions, and primary actions.",
  accentText: "Readable text on the accent color.",
  message: "Incoming message bubbles.",
  ownMessage: "Your outgoing message bubbles.",
};

function editableScheme(
  scheme: CustomScheme,
): Record<CustomSchemeColor, string> {
  return { ...scheme };
}

function parseDraft(draft: Record<CustomSchemeColor, string>): {
  scheme: CustomScheme | null;
  errors: Partial<Record<CustomSchemeColor, string>>;
} {
  const errors: Partial<Record<CustomSchemeColor, string>> = {};
  const scheme: Partial<Record<CustomSchemeColor, string>> = {};
  for (const color of CUSTOM_SCHEME_COLORS) {
    const normalized = normalizeHexColor(draft[color]);
    if (!normalized) errors[color] = "Use a 3- or 6-digit hex color.";
    else scheme[color] = normalized;
  }
  return {
    scheme: Object.keys(errors).length ? null : (scheme as CustomScheme),
    errors,
  };
}

export function CustomColorSchemeEditor({
  scheme,
  enabled,
  onSave,
  onDisable,
}: {
  scheme: CustomScheme;
  enabled: boolean;
  onSave: (scheme: CustomScheme) => void;
  onDisable: () => void;
}) {
  const [draft, setDraft] = useState(() => editableScheme(scheme));
  useEffect(() => setDraft(editableScheme(scheme)), [scheme]);
  const { scheme: parsed, errors } = parseDraft(draft);
  return (
    <SettingsGroup layout="form">
      <div
        className="rounded-3xl border p-4"
        style={
          {
            ...customSchemeStyle((parsed ?? scheme) as CustomScheme),
            background: "var(--custom-scheme-panel)",
            borderColor: "var(--custom-scheme-border)",
            color: "var(--custom-scheme-text)",
          } as CSSProperties
        }
        data-custom-color-scheme="custom"
      >
        <div
          className="mb-3 flex items-center justify-between border-b pb-3"
          style={{ borderColor: "var(--custom-scheme-border)" }}
        >
          <span className="text-label">Custom preview</span>
          <span
            className="rounded-full px-3 py-1 text-label"
            style={{
              background: "var(--custom-scheme-accent)",
              color: "var(--custom-scheme-accent-text)",
            }}
          >
            Accent
          </span>
        </div>
        <div className="flex flex-col gap-2 text-body-sm">
          <div
            className="max-w-[70%] rounded-lg p-3"
            style={{ background: "var(--custom-scheme-message)" }}
          >
            Incoming bubble with your custom surface.
          </div>
          <div
            className="ml-auto max-w-[70%] rounded-lg p-3"
            style={{ background: "var(--custom-scheme-own-message)" }}
          >
            Your bubble uses its own color.
          </div>
          <div
            className="mt-2 rounded-2xl border p-3"
            style={{
              background: "var(--custom-scheme-inset)",
              borderColor: "var(--custom-scheme-border)",
              color: "var(--custom-scheme-subtle-text)",
            }}
          >
            Inset controls and helper text follow the same scheme.
          </div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {CUSTOM_SCHEME_COLORS.map((color) => (
          <Field
            key={color}
            label={LABELS[color]}
            description={DESCRIPTIONS[color]}
            error={errors[color]}
          >
            <Input
              value={draft[color]}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, [color]: value }))
              }
            />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setDraft(editableScheme(DEFAULT_CUSTOM_SCHEME))}
        >
          Use sample scheme
        </Button>
        {enabled && (
          <Button type="button" onClick={onDisable}>
            Turn off custom scheme
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={!parsed}
          onClick={() => parsed && onSave(parsed)}
        >
          Save custom scheme
        </Button>
      </div>
    </SettingsGroup>
  );
}
