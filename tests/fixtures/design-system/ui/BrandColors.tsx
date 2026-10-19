import { useState } from "react";
import {
  BRAND_FAMILIES,
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
  const [family, setFamily] = useState("cobalt");
  const [scope, setScope] = useState<HTMLDivElement | null>(null);
  const { scheme } = useColorScheme();
  const [copyStatus, setCopyStatus] = useState("");
  const resolved = useResolvedTokens(variables, scope);
  const value = resolved.get(selected)?.value ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `[data-accent="${family}"][data-color-mode="${scheme}"] { color: var(${selected}); }`,
      );
      setCopyStatus("Copied CSS variable.");
    } catch {
      setCopyStatus(
        "Could not copy. Select the CSS variable below to copy it manually.",
      );
    }
  }

  return (
    <Section
      title="Colorways and plugin gradients"
      description="Six existing accent families, shared with plugin identities. The ramps below are the real theme-aware accent values. Decorative gradients follow each family’s hue at matched luminance, so the categories stay distinct without one looking substantially brighter than another."
    >
      <div className="brand-gradient-grid">
        {BRAND_GRADIENTS.map((gradient) => (
          <div
            key={gradient.name}
            className="flex w-full min-w-0 flex-col gap-2"
          >
            <div
              className="h-16 rounded-md"
              style={{
                background: `var(--art-${gradient.family}-gradient)`,
              }}
            />
            <span className="text-body-sm text-primary">{gradient.name}</span>
            <span className="text-body-sm text-secondary">
              {gradient.family}
            </span>
          </div>
        ))}
      </div>
      <p className="text-body-sm text-secondary">
        Gradient endpoints target the same luminance: approximately 4.57:1
        against white and 4.60:1 against black. Lighting and artwork overlays
        need a separate visual check; these measurements describe the bare
        gradients.
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
          Copy CSS
        </Button>
      </div>
      <p role="status" className="text-body-sm text-secondary">
        {copyStatus}
      </p>
      <div className="flex flex-col gap-6">
        {BRAND_FAMILIES.map((colorway) => (
          <div
            key={colorway.id}
            className="flex flex-col gap-2"
            data-accent={colorway.id}
            data-color-mode={scheme}
          >
            <h3 className="text-label text-primary">{colorway.id}</h3>
            <div className="brand-color-ramp">
              {BRAND_SHADES.map((shade) => {
                const variable = `--accent-${shade}`;
                const active = selected === variable && family === colorway.id;
                return (
                  <Button
                    key={shade}
                    variant={active ? "outline" : "ghost"}
                    shape="control"
                    size="sm"
                    aria-label={`${colorway.id} ${shade}`}
                    aria-pressed={active}
                    onClick={() => {
                      setSelected(variable);
                      setFamily(colorway.id);
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
