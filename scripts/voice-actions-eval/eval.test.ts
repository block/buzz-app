// Offline checks of the eval itself: every case builds a valid request whose
// expected answer is reachable, so a miss in a live run is Jev's, not a typo.
import { describe, expect, it } from "vitest";
import { checkRequest } from "../../src/features/decisions/service";
import { ACTIONS, ENTITIES, PLACES, hover, UNOFFERED } from "./catalog";
import { CASES } from "./cases";
import { FINAL, HERE } from "./cases-final";
import { REALSTT } from "./cases-realstt";
import { HELDOUT, HELDOUT2, HELDOUT3 } from "./cases-heldout";
import {
  buildActionDecision,
  matchActionBindings,
} from "../../src/features/search/voice-actions";
import {
  extractNewSectionName,
  extractRenameText,
} from "../../src/features/search/voice-actions-sidebar";
import { score } from "./eval";

describe("voice actions eval", () => {
  it("builds a valid request for every case, with its answer offered", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(HELDOUT.length).toBeGreaterThanOrEqual(30);
    const keys = new Set(
      Object.values(ENTITIES).flatMap((list) => list.map((e) => e.id)),
    );
    for (const c of [
      ...CASES,
      ...HELDOUT,
      ...HELDOUT2,
      ...HELDOUT3,
      ...FINAL,
      ...HERE,
      ...REALSTT,
    ]) {
      const hovered = hover(c.hover);
      const { request } = buildActionDecision({
        spoken: c.spoken,
        hovered,
        actions: ACTIONS,
        entities: ENTITIES,
        places: PLACES,
      });
      if (!request) throw new Error(`${c.id}: no request`);
      expect(checkRequest(request), c.id).toBeUndefined();
      const e = c.expect;
      if ("navigate" in e)
        expect(
          PLACES.map((p) => p.key),
          c.id,
        ).toContain(e.navigate);
      // A case asking for an action the app doesn't offer expects none.
      if ("action" in e && UNOFFERED.has(e.action))
        expect(ACTIONS.map((a) => a.id)).not.toContain(e.action);
      else if ("action" in e) {
        const offered = matchActionBindings(ACTIONS, hovered, ENTITIES).map(
          (b) => b.action.id,
        );
        // Starring from the Starred section is a move into it.
        expect(offered, c.id).toContain(
          e.action === "channel.star" &&
            hovered?.kind !== "nothing" &&
            hovered?.id === "s-Starred"
            ? "channel.move_to_section"
            : e.action,
        );
        for (const k of [e.owner, e.target])
          if (
            k &&
            !k.startsWith("m-") &&
            !(hovered && hovered.kind !== "nothing" && k === hovered.id)
          )
            expect(keys.has(k), `${c.id} ${k}`).toBe(true);
      }
    }
  });

  it("binds a hovered thing as owner and as target", () => {
    const options = (spec: string) =>
      matchActionBindings(ACTIONS, hover(spec), ENTITIES).map(
        (b) => `${b.action.id}:${b.hoveredRole}`,
      );
    expect(options("#jev")).toEqual(
      expect.arrayContaining([
        "channel.star:owner",
        "channel.move_to_section:owner",
      ]),
    );
    expect(options("section:Work")).toContain("channel.move_to_section:target");
    expect(options("person:Wes")).toContain("channel.add_member:target");
  });

  it("takes a new name from the words after the action", () => {
    expect(extractNewSectionName("add buzz community")).toBe("Buzz Community");
    expect(extractNewSectionName("create a section called reading list")).toBe(
      "Reading List",
    );
    expect(extractRenameText("rename this section fun stuff")).toBe(
      "Fun Stuff",
    );
    expect(extractNewSectionName("hmm")).toBeUndefined();
  });

  it("counts only a sure answer as acting", () => {
    expect(
      score({ none: true }, { kind: "none", probability: 1 }).correct,
    ).toBe(true);
    expect(
      score({ none: true }, { kind: "navigate", place: "x", probability: 0.4 })
        .correct,
    ).toBe(true);
    expect(
      score(
        { navigate: "x" },
        { kind: "navigate", place: "x", probability: 0.9 },
      ),
    ).toEqual({ correct: true, intentCorrect: true, acted: true });
  });
});
