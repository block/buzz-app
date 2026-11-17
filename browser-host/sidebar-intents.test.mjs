import { expect, it } from "vitest";
import { assertSidebarAssignmentIntent } from "./sidebar-preferences.mjs";
import { assertSidebarMuteIntent } from "./sidebar-toggle.mjs";

it("keeps broker-only envelope checks before shared sidebar policy", () => {
  const cases = [
    [assertSidebarAssignmentIntent, { channelId: "c" }],
    [assertSidebarMuteIntent, { channelId: "c", muted: false }],
  ];
  for (const [assertIntent, valid] of cases) {
    expect(() => assertIntent(valid)).not.toThrow();
    for (const invalid of [null, [], {}, { ...valid, extra: true }])
      expect(() => assertIntent(invalid)).toThrow("Invalid sidebar");
  }
  for (const createSection of [
    null,
    false,
    [],
    { id: "x", name: "Work" },
    { id: "11111111-1111-1111-1111-111111111111", name: "Work", extra: true },
  ])
    expect(() =>
      assertSidebarAssignmentIntent({ channelId: "c", createSection }),
    ).toThrow("Invalid sidebar assignment intent");
  expect(() => assertSidebarMuteIntent({ channelId: 1, muted: false })).toThrow(
    "Invalid sidebar mute intent",
  );
});
