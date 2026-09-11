import { describe, expect, it } from "vitest";
import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";
import { COMPONENT_SPECIMENS } from "./componentSpecimens";

describe("core-only viewer catalog", () => {
  it("renders every registered component and no removed feature specimens", () => {
    expect(Object.keys(COMPONENT_SPECIMENS).sort()).toEqual(
      COMPONENTS.map((component) => component.slug).sort(),
    );
    for (const component of COMPONENTS) {
      expect(component.source).toMatch(/^shared\/design-system\//);
    }
  });
});
