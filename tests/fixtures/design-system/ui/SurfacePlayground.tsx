import { useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { NavigationItem } from "../../../../src/shared/design-system/ui/NavigationItem";
import { Panel } from "../../../../src/shared/design-system/ui/Panel";
import { PanelHeader } from "../../../../src/shared/design-system/ui/PanelHeader";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../../../src/shared/design-system/ui/Menu";
import { PageHeader, Section } from "./primitives";
import "./systemPlaygrounds.css";

const surfaces = [
  ["Base", "surface-base"],
  ["Panel", "surface-panel"],
  ["Inset", "surface-inset"],
  ["Floating", "surface-popover"],
] as const;

function SurfaceControls({ name }: { name: string }) {
  const [selected, setSelected] = useState("Conversation");
  return (
    <div className="system-sweep-controls">
      <p className="text-label text-standard">Ready for the next idea</p>
      <p className="text-body text-subtle">
        Supporting text should stay readable on every layer.
      </p>
      <span className="text-caption text-metadata">
        Updated just now · 12 members
      </span>
      <div className="system-sweep-actions">
        <Button variant="subtle" size="sm">
          Subtle
        </Button>
        <Button variant="ghost" size="sm">
          Ghost
        </Button>
        <Button variant="outline" size="sm">
          Outline
        </Button>
        <Button disabled size="sm">
          Unavailable
        </Button>
      </div>
      <Field label={`${name} name`}>
        <Input placeholder="A useful placeholder" />
      </Field>
      <Checkbox label="Keep me in the loop" defaultChecked />
      <nav aria-label={`${name} navigation`}>
        {["Conversation", "Files"].map((label) => (
          <NavigationItem
            key={label}
            label={label}
            selected={selected === label}
            onClick={() => setSelected(label)}
          />
        ))}
      </nav>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button variant="subtle" size="sm">
              Open {name.toLowerCase()} menu
            </Button>
          }
        />
        <MenuPopup size="compact">
          <MenuItem>View details</MenuItem>
          <MenuItem>Copy reference</MenuItem>
          <MenuItem disabled>Archive unavailable</MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}

export function SurfacePlayground() {
  const [backdrop, setBackdrop] = useState(false);
  return (
    <>
      <PageHeader
        title="Colors & surfaces"
        intro="Try real controls on the layers they live on. Toggle the theme, hover each action, and open menus above both panels and floating surfaces."
      />
      <Section
        title="A surface above a surface"
        description="Elevation has two relationships: separation from the layer below, and enough room for controls above it. Shadows stay quiet; dark elevation comes from the fill."
      >
        <Checkbox
          label="Show the app gradient behind the panel"
          checked={backdrop}
          onCheckedChange={setBackdrop}
        />
        <div
          className="system-sweep-stage"
          data-gradient={backdrop || undefined}
        >
          <Panel>
            <PanelHeader title="Design conversation" />
            <div className="system-sweep-stack">
              <div className="system-sweep-controls">
                <p className="text-body text-standard">
                  A quiet panel keeps the conversation in focus.
                </p>
                <p className="text-body text-subtle">
                  Open the menu to compare another floating layer.
                </p>
                <Button size="sm">Start conversation</Button>
              </div>
              <div className="floating-surface system-sweep-raised">
                <SurfaceControls name="Raised" />
              </div>
            </div>
          </Panel>
        </div>
      </Section>
      <Section
        title="The same controls, four backgrounds"
        description="Hover is temporary; selection is persistent. Compare filled actions, quiet actions, readable metadata, field boundaries, and selected rows on every surface."
      >
        <div className="system-sweep-grid">
          {surfaces.map(([name, role]) => (
            <article
              key={role}
              aria-label={`${name} surface`}
              className="system-sweep-surface"
              style={{ background: `var(--${role})` }}
            >
              <h3 className="text-label text-standard">{name}</h3>
              <code className="text-mono text-metadata">{role}</code>
              <SurfaceControls name={name} />
            </article>
          ))}
        </div>
      </Section>
      <Section
        title="Content carries the contrast"
        description="Body text, supporting text, metadata, links, and status labels are checked against their surfaces. Decorative dividers and hover fills can stay subtle."
      >
        <div className="system-sweep-actions">
          <span className="text-body text-standard">Standard text</span>
          <span className="text-body text-subtle">Supporting text</span>
          <span className="text-caption text-metadata">Metadata</span>
          <a
            className="text-body text-link underline"
            href="#/design/color/table"
          >
            Token table
          </a>
          <span className="text-body text-danger">Couldn’t save</span>
          <span className="text-body text-success">Saved</span>
        </div>
        <p className="text-body text-subtle">
          The existing hidden focus outlines and light Away badge are documented
          accessibility exceptions. This playground does not claim a full
          accessibility audit.
        </p>
      </Section>
    </>
  );
}
