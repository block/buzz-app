// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, assert, expect, it } from "vitest";
import { StrictMode } from "react";
import { OwnedContribution } from "./OwnedContribution";

afterEach(cleanup);
it("revokes captured callbacks when an exact registration or its presentation retires", () => {
  const first = { id: "templates", revision: "bundled" };
  let entries = [first];
  const registry = { snapshot: () => entries };
  const captured: (() => boolean)[] = [];
  const view = (entry: typeof first) => (
    <StrictMode>
      <OwnedContribution entry={entry} registry={registry}>
        {(_entry, active) => {
          captured.push(active);
          return null;
        }}
      </OwnedContribution>
    </StrictMode>
  );
  const mounted = render(view(first));
  const original = captured.at(-1);
  assert.exists(original);
  expect(original()).toBe(true);
  // Revocation is synchronous even before React processes the removal.
  entries = [];
  expect(original()).toBe(false);
  const replacement = { ...first };
  entries = [replacement];
  act(() => mounted.rerender(view(replacement)));
  expect(original()).toBe(false);
  const current = captured.at(-1);
  assert.exists(current);
  expect(current()).toBe(true);
  mounted.unmount();
  expect(current()).toBe(false);
});
