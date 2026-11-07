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

it.each([
  {
    mention: "ping",
    direct: "unison",
    thread: "doop",
    post: "soft",
    agent: "doodone",
  },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    post: "silent",
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

it("channels set to All new posts round-trip; older values restore none", () => {
  expect(parsePreferences(stored).allPosts).toEqual([]);
  expect(
    parsePreferences(
      JSON.parse(JSON.stringify({ ...stored, allPosts: ["c1", "c2"] })),
    ).allPosts,
  ).toEqual(["c1", "c2"]);
  for (const allPosts of ["c1", [""], ["c1", "c1"], [7]])
    expect(() => parsePreferences({ ...stored, allPosts })).toThrow(
      "Invalid notification channels",
    );
});
