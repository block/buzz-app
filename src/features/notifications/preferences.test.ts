import { expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parsePreferences,
} from "./preferences";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it("keeps existing badge behavior and restores a separately chosen badge filter", () => {
  expect(parsePreferences(stored).badgeActivity).toBe("all");
  const preferences = parsePreferences({
    ...stored,
    enabled: false,
    badgeActivity: "mentions-and-dms",
  });
  expect(parsePreferences(JSON.parse(JSON.stringify(preferences)))).toEqual(
    preferences,
  );
  expect(preferences.enabled).toBe(false);
  expect(() =>
    parsePreferences({ ...stored, badgeActivity: "unknown" }),
  ).toThrow("Invalid badge activity");
});

it.each([
  { mention: "ping", direct: "unison", thread: "doop", agent: "doodone" },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    agent: "silent",
  },
])(
  "saved sound choices round-trip and unknown names reject the payload: %j",
  (sounds) => {
    expect(
      parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds })))
        .sounds,
    ).toEqual(sounds);
    expect(() => parsePreferences({ ...stored, sounds: "ping" })).toThrow(
      "Invalid notification sounds",
    );
    expect(() =>
      parsePreferences({ ...stored, sounds: { mention: "klaxon" } }),
    ).toThrow("Invalid notification sounds");
  },
);
