import { expect, test } from "vitest";
import { draftError, exactSaveReadback, visualForm } from "./editor-model";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureYaml,
} from "./fixtures";

test("advanced fields stay raw; opening does not transform source", () => {
  expect(visualForm(fixtureYaml).ok).toBe(true);
  expect(visualForm(`${fixtureYaml}future: retain-me\n`).ok).toBe(false);
  expect(visualForm(fixtureYaml.replace("message_posted", "webhook")).ok).toBe(
    false,
  );
  expect(
    visualForm(fixtureYaml.replace("    text:", "    if: true\n    text:")).ok,
  ).toBe(false);
  expect(draftError(fixtureYaml)).toBeNull();
  expect(
    draftError(fixtureYaml.replace("text: Hello from a fixture", "text: ''")),
  ).toMatch(/message text/);
});
test("save readback requires operation revision plus owner/channel/id", () => {
  const fixture = createWorkflowFixture();
  const eventId = fixture.capability.save({
    channelId: fixtureDefinition.channelId,
    yaml: fixtureYaml,
    existing: fixtureDefinition,
  });
  fixture.finish("succeeded");
  const operation = fixture.capability.operations.snapshot()[0];
  if (!operation) throw new Error("fixture operation missing");
  const exact = { ...fixtureDefinition, revision: eventId };
  expect(exactSaveReadback(operation, [exact])).toEqual(exact);
  for (const wrong of [
    fixtureDefinition,
    { ...exact, owner: "22".repeat(32) },
    { ...exact, channelId: "other" },
    { ...exact, id: "other" },
  ])
    expect(exactSaveReadback(operation, [wrong])).toBeUndefined();
  expect(
    exactSaveReadback({ ...operation, outcome: "unknown" }, [exact]),
  ).toBeUndefined();
});
