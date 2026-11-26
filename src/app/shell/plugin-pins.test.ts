// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { writeView } from "../../shared/view-state";
import { savedPluginPins, savePluginPins } from "./plugin-pins";

afterEach(() => localStorage.clear());

test("no saved choice reads as undefined, an empty choice as empty", () => {
  expect(savedPluginPins()).toBeUndefined();
  savePluginPins([]);
  expect(savedPluginPins()).toEqual([]);
});

test("saved pins keep their order without duplicates", () => {
  savePluginPins(["buzz.reminders", "fixture.notes", "buzz.reminders"]);
  expect(savedPluginPins()).toEqual(["buzz.reminders", "fixture.notes"]);
  expect(savedPluginPins()).toBe(savedPluginPins());
});

test("malformed records read as no choice or drop bad entries", () => {
  writeView("shell", "plugin-pins", { not: "a list" });
  expect(savedPluginPins()).toBeUndefined();
  writeView("shell", "plugin-pins", ["buzz.inbox", 7, ""]);
  expect(savedPluginPins()).toEqual(["buzz.inbox"]);
});
