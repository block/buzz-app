import { useEffect, useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { PageHeader, Section } from "./primitives";
import "./systemPlaygrounds.css";

export function RemPlayground() {
  const [rootSize, setRootSize] = useState("100");
  const [textScale, setTextScale] = useState("100");
  const [narrow, setNarrow] = useState(false);
  const [draft, setDraft] = useState(
    "A long project name that should remain readable",
  );
  useEffect(() => {
    const root = document.documentElement;
    const previousSize = root.style.getPropertyValue("font-size");
    const previousScale = root.style.getPropertyValue("--type-scale");
    root.style.setProperty("font-size", `${rootSize}%`);
    root.style.setProperty("--type-scale", String(Number(textScale) / 100));
    return () => {
      if (previousSize) root.style.setProperty("font-size", previousSize);
      else root.style.removeProperty("font-size");
      if (previousScale) root.style.setProperty("--type-scale", previousScale);
      else root.style.removeProperty("--type-scale");
    };
  }, [rootSize, textScale]);
  return (
    <>
      <PageHeader
        title="Rem & text sizing"
        intro="Change the root size to scale rem geometry, or enlarge only the text to exercise Buzz’s existing text-size behavior. The controls affect this viewer temporarily and reset when you leave."
      />
      <Section title="Set the conditions">
        <div className="system-sweep-actions">
          <Select
            label="Root size"
            value={rootSize}
            onValueChange={setRootSize}
            groups={[
              {
                label: "Root font size",
                options: [100, 125, 150, 200].map((value) => ({
                  value: String(value),
                  label: `${value}% root`,
                })),
              },
            ]}
          />
          <Select
            label="Text scale"
            value={textScale}
            onValueChange={setTextScale}
            groups={[
              {
                label: "Text only",
                options: [80, 100, 150, 200].map((value) => ({
                  value: String(value),
                  label: `${value}% text`,
                })),
              },
            ]}
          />
          <Button
            variant="subtle"
            size="sm"
            onClick={() => {
              setRootSize("100");
              setTextScale("100");
              setNarrow(false);
            }}
          >
            Reset sizing
          </Button>
        </div>
        <Checkbox
          label="Constrain the specimen to a narrow column"
          checked={narrow}
          onCheckedChange={setNarrow}
        />
        <p role="status" className="text-body text-subtle tabular-nums">
          Root {rootSize}% · Text {textScale}% · Combined type{" "}
          {(Number(rootSize) * Number(textScale)) / 100}%
        </p>
      </Section>
      <Section
        title="Relative geometry"
        description="The rem bar follows the root. The pixel reference stays fixed. Text-only scaling leaves both bars unchanged."
      >
        <div className="system-rem-rulers">
          <div>
            <span className="text-caption text-subtle">10 rem</span>
            <div className="system-rem-ruler" />
          </div>
          <div>
            <span className="text-caption text-subtle">160 px reference</span>
            <div className="system-px-ruler" />
          </div>
        </div>
      </Section>
      <Section
        title="Read, wrap, and interact"
        description="Watch line breaks, field height, button labels, and popup placement. Draft text should survive every adjustment."
      >
        <div className="system-rem-specimen" data-narrow={narrow || undefined}>
          <h3 className="text-heading text-standard">
            A conversation with room to grow
          </h3>
          <p className="text-body text-standard">
            Good sizing keeps long names, useful descriptions, and changing
            numbers readable. This paragraph should wrap naturally without
            colliding with the next control.
          </p>
          <p className="text-body text-subtle">
            A reference with no convenient break:{" "}
            <span className="system-rem-long-value">
              project_design_system_surface_relationships_and_typography_review
            </span>
          </p>
          <Field
            label="Project name"
            description="Try editing this before changing either scale."
          >
            <Input value={draft} onValueChange={setDraft} />
          </Field>
          <Checkbox
            label="Include the full description when sharing this conversation"
            defaultChecked
          />
          <div className="system-sweep-actions">
            <Button size="sm">Save changes</Button>
            <Button size="sm" variant="subtle">
              Keep editing
            </Button>
          </div>
          <p className="text-caption text-metadata tabular-nums">
            12 members · 128 messages · Updated at 09:41
          </p>
        </div>
      </Section>
      <Section
        title="What remains in pixels"
        description="One-pixel dividers, focus strokes, optical nudges, and browser or media coordinates are intentionally physical. Rem is for authored UI size and space; unitless line-height and content-sized controls let text grow independently."
      >
        <p className="text-body text-subtle">
          This control does not change your saved app appearance. Browser zoom,
          mobile input zoom, and native window behavior still need their own
          device checks.
        </p>
      </Section>
    </>
  );
}
