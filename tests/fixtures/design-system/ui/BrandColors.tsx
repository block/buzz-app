import { BRAND_GRADIENTS } from "../../../../src/shared/design-system/tokens/brand";
import { Section } from "./primitives";

export function BrandColors() {
  return (
    <Section
      title="Colorways and plugin gradients"
      description="Plugin artwork now uses existing palette steps. Each endpoint follows its family in light and dark mode. Existing Appearance solid fills give categories distinct identities; their complete ramps remain references."
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
    </Section>
  );
}
