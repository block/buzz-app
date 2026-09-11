import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";
import { BaseUiBackingLine } from "./BaseUiBackingLine";
import { COMPONENT_SPECIMENS } from "./componentSpecimens";
import { MissingPage } from "./MissingPage";

export function ComponentDetailPage({ slug }: { slug: string }) {
  const component = COMPONENTS.find((candidate) => candidate.slug === slug);
  if (!component) return <MissingPage what="component" />;
  const Specimen = COMPONENT_SPECIMENS[component.slug];

  return (
    <>
      <header className="component-page-heading">
        <h1 className="text-title text-primary">{component.name}</h1>
        <p className="text-body text-tertiary">
          {component.purpose}
          <BaseUiBackingLine slug={component.slug} />
        </p>
      </header>
      {Specimen ? <Specimen /> : null}
    </>
  );
}
