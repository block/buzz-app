import { useState } from "react";
import {
  BRAND_FAMILIES,
  BRAND_GRADIENTS,
  BRAND_SHADES,
} from "../../../../src/shared/design-system/tokens/brand";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { useResolvedTokens } from "../useResolvedToken";
import { Section } from "./primitives";

const variables = BRAND_FAMILIES.flatMap((family) =>
  BRAND_SHADES.map((shade) => `--brand-${family.id}-${shade}`),
);

export function BrandColors() {
  const [selected, setSelected] = useState("--brand-cyan-500");
  const [copyStatus, setCopyStatus] = useState("");
  const resolved = useResolvedTokens(variables);
  const value = resolved.get(selected)?.value ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(`var(${selected})`);
      setCopyStatus("Copied CSS variable.");
    } catch {
      setCopyStatus(
        "Could not copy. Select the CSS variable below to copy it manually.",
      );
    }
  }

  return (
    <Section
      title="Plugin color families"
      description="Explore the twelve colors behind the six plugin gradients. Each 500 stop is an exact source color; 50–950 explores lighter and darker shades. These fixed scales keep the same values in both themes. Use semantic roles for product UI."
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
                background: `linear-gradient(to bottom, var(--brand-${gradient.from}-500), var(--brand-${gradient.to}-500))`,
              }}
            />
            <span className="text-body-sm text-primary">{gradient.name}</span>
            <span className="text-body-sm text-secondary">
              {gradient.from} → {gradient.to}
            </span>
          </div>
        ))}
      </div>
      <p className="text-body-sm text-secondary">
        Original gradient stops, before the icon lighting and artwork overlays.
        Family names are exploratory; nearby hues remain separate to preserve
        every source color.
      </p>
      <div className="brand-color-selection">
        <span
          aria-hidden="true"
          className="h-10 w-16 shrink-0 rounded-md border border-primary"
          style={{ background: `var(${selected})` }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1" aria-live="polite">
          <code className="break-all text-mono text-primary">
            var({selected})
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
        {BRAND_FAMILIES.map((family) => (
          <div key={family.id} className="flex flex-col gap-2">
            <h3 className="text-label text-primary">{family.id}</h3>
            <div className="brand-color-ramp">
              {BRAND_SHADES.map((shade) => {
                const variable = `--brand-${family.id}-${shade}`;
                return (
                  <Button
                    key={shade}
                    variant={selected === variable ? "outline" : "ghost"}
                    shape="control"
                    size="sm"
                    aria-label={`${family.id} ${shade}`}
                    aria-pressed={selected === variable}
                    onClick={() => {
                      setSelected(variable);
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
