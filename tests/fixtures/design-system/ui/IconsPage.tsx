import {
  CUSTOM_ICONS,
  PHOSPHOR_ICONS,
} from "../../../../src/shared/design-system/icons/inventory";
import { PageHeader, Section } from "./primitives";

function displayName(name: string) {
  return name.replace(/Icon$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function IconsPage() {
  return (
    <>
      <PageHeader
        title="Icons"
        intro="Phosphor is Buzz’s sole general-purpose icon family. Products request the icons they need through the shared design-system gateway; they do not import the upstream catalog directly."
      />

      <Section
        title="Available Phosphor icons"
        description="This inventory is generated from the gateway’s real exports. Adding an approved export updates this page without a second list or bundling the full Phosphor catalog."
      >
        <ul
          className="icon-inventory-grid"
          aria-label="Available Phosphor icons"
        >
          {PHOSPHOR_ICONS.map(({ name, component: Icon }) => (
            <li className="icon-inventory-item" key={name}>
              <Icon size={24} />
              <span className="text-body-sm text-secondary">
                {displayName(name)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Custom and approved icons"
        description="Use these only for the specific meaning shown. Their provenance and intended product size remain visible with the artwork."
      >
        <div className="custom-icon-inventory">
          {CUSTOM_ICONS.map(
            ({
              name,
              component: Icon,
              meaning,
              category,
              provenance,
              intendedSizes,
            }) => (
              <article className="custom-icon-item" key={name}>
                <div className="custom-icon-examples">
                  {intendedSizes.map(({ width, height }) => (
                    <div
                      className="custom-icon-example"
                      key={`${width}x${height}`}
                    >
                      <Icon size={height} />
                      <span className="text-mono-sm text-tertiary">
                        {width} × {height}px
                      </span>
                    </div>
                  ))}
                </div>
                <div className="custom-icon-copy">
                  <h3 className="text-heading text-primary">{meaning}</h3>
                  <p className="text-body-sm text-secondary">{category}</p>
                  <p className="text-body-sm text-tertiary">{provenance}</p>
                </div>
              </article>
            ),
          )}
        </div>
      </Section>
    </>
  );
}
