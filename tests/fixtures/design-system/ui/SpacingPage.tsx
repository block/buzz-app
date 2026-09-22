import {
  SPACE,
  SPACE_ROLES,
} from "../../../../src/shared/design-system/tokens/registry";
import { FoundationScale } from "./FoundationScale";
import { PageHeader, Section } from "./primitives";
import { Link } from "@tanstack/react-router";

export function SpacingPage() {
  return (
    <>
      <PageHeader
        title="Spacing"
        status="forming"
        intro="A short six-step rhythm extracted from the Messages frame. The first roles capture only the relationships repeated by the workspace and its dense navigator; new roles arrive when another real component earns them."
      />

      <Section
        title="Scale"
        description="Components use these steps through roles where the distance carries product meaning."
      >
        <FoundationScale
          items={SPACE.map((item) => ({
            token: `space ${item.step}`,
            value: item.value,
            use: item.use,
          }))}
        />
      </Section>

      <Section
        title="Implementation rule: align row content"
        description="Align a dialog's heading with the leading content column of its rows. Let hover and selection backgrounds extend around that content."
      >
        <p className="max-w-2xl text-body text-secondary">
          Keep NavigationItem padding intact and offset the list wrapper using
          the control-inset token. Use equal icon slots, preserve an 8px outer
          gutter on compact dialogs, and leave room for keyboard focus inside
          scrollable lists. Empty states follow the same content edge.
        </p>
        <Link to="/design/design-guide" className="text-body underline">
          Read DESIGN.md → Align row content, not state backgrounds
        </Link>
      </Section>

      <Section title="Roles">
        <FoundationScale
          items={SPACE_ROLES.map((item) => ({
            token: item.token,
            value: item.pointsAt,
            use: item.use,
          }))}
        />
      </Section>
    </>
  );
}
