import { useState } from "react";
import {
  ACCENTS,
  BRAND_GRADIENTS,
  BRAND_SHADES,
} from "../../../../src/shared/design-system/tokens/brand";
import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { useResolvedTokens } from "../useResolvedToken";
import { Section } from "./primitives";

const variables = BRAND_SHADES.map((shade) => `--accent-${shade}`);

export function BrandColors() {
  const [selected, setSelected] = useState("--accent-9");
  const [family, setFamily] = useState<string>(ACCENTS[0]);
  const [scope, setScope] = useState<HTMLDivElement | null>(null);
  const { scheme } = useColorScheme();
  const [copyStatus, setCopyStatus] = useState("");
  const resolved = useResolvedTokens(variables, scope);
  const value = resolved.get(selected)?.value ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied color value.");
    } catch {
      setCopyStatus(
        "Could not copy. Select the color value below to copy it manually.",
      );
    }
  }

  return (
    <Section
      title="Colorways and plugin gradients"
      description="Plugin artwork now uses existing palette steps. Each endpoint follows its family in light and dark mode. Hue substitutions and collapsed transitions are called out below; the Appearance ramps remain references."
    >
      <div className="brand-gradient-grid">
        {BRAND_GRADIENTS.map((gradient) => (
          <div
            key={gradient.category}
            className="flex w-full min-w-0 flex-col gap-2"
          >
            <div
              className="h-16 rounded-md"
              style={{
                background: `var(--art-plugin-${gradient.category}-gradient)`,
              }}
            />
            <span className="text-body-sm text-primary">{gradient.name}</span>
            <span className="text-body-sm text-secondary">
              {gradient.start} → {gradient.end}
            </span>
            <p className="text-body-sm text-secondary">{gradient.compromise}</p>
          </div>
        ))}
      </div>
      <p className="text-body-sm text-secondary">
        Family references follow the active theme. Shared luminance, chroma,
        contrast and the original 35° hue shifts are no longer guaranteed.
        Compare the real catalog in both modes before judging the mapping.
      </p>
      <div
        className="brand-color-selection"
        ref={setScope}
        data-accent={family}
        data-color-mode={scheme}
      >
        <span
          aria-hidden="true"
          className="h-10 w-16 shrink-0 rounded-md border border-primary"
          style={{ background: `var(${selected})` }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1" aria-live="polite">
          <code className="break-all text-mono text-primary">
            {family} · var({selected})
          </code>
          <code className="break-all text-mono text-secondary">{value}</code>
        </div>
        <Button size="sm" onClick={() => void copy()}>
          Copy value
        </Button>
      </div>
      <p role="status" className="text-body-sm text-secondary">
        {copyStatus}
      </p>
      <div className="flex flex-col gap-6">
        {ACCENTS.map((colorway) => (
          <div
            key={colorway}
            className="flex flex-col gap-2"
            data-accent={colorway}
            data-color-mode={scheme}
          >
            <h3 className="text-label text-primary">{colorway}</h3>
            <div className="brand-color-ramp">
              {BRAND_SHADES.map((shade) => {
                const variable = `--accent-${shade}`;
                const active = selected === variable && family === colorway;
                return (
                  <Button
                    key={shade}
                    variant={active ? "outline" : "ghost"}
                    shape="control"
                    size="sm"
                    aria-label={`${colorway} ${shade}`}
                    aria-pressed={active}
                    onClick={() => {
                      setSelected(variable);
                      setFamily(colorway);
                      setCopyStatus("");
                    }}
                  >
                    <span className="flex w-full min-w-0 flex-col gap-2">
                      <span
                        aria-hidden="true"
                        className="block h-10 w-full rounded-sm border border-primary"
                        style={{ background: `var(${variable})` }}
                      />
                      <span>{shade}</span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
