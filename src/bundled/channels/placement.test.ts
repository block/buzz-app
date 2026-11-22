// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { placeOpening } from "./placement";

const open = { hasTab: false, canHold: true };
const live = { kind: "panel", panel: { inline: false } } as const;

describe("placeOpening", () => {
  afterEach(() => setThreadPlacementPreference("side"));

  it("opens everything as a tab unless the setting is inline", () => {
    for (const setting of ["side", "main"] as const) {
      setThreadPlacementPreference(setting);
      for (const opening of [
        { kind: "thread" },
        { kind: "panel", panel: {} },
        { kind: "chat" },
      ] as const)
        expect(placeOpening(opening, open)).toBe("tab");
    }
  });

  it("opens threads, panels and chat links inline under inline", () => {
    setThreadPlacementPreference("inline");
    expect(placeOpening({ kind: "thread" }, open)).toBe("inline");
    expect(placeOpening({ kind: "panel", panel: {} }, open)).toBe("inline");
    expect(placeOpening({ kind: "chat" }, open)).toBe("inline");
  });

  it("keeps a live panel, an existing tab and a view without dialogs as tabs", () => {
    setThreadPlacementPreference("inline");
    // Huddles, Canvas and apps declare `inline: false`.
    expect(placeOpening(live, open)).toBe("tab");
    expect(
      placeOpening({ kind: "panel", panel: {} }, { ...open, hasTab: true }),
    ).toBe("tab");
    expect(placeOpening({ kind: "thread" }, { ...open, hasTab: true })).toBe(
      "tab",
    );
    expect(placeOpening({ kind: "thread" }, { ...open, canHold: false })).toBe(
      "tab",
    );
  });
});
