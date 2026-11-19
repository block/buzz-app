import { describe, expect, it } from "vitest";
import { systemPrompt } from "../../../bundled/claude-code/prompt";
import { developerInstructions } from "../../../bundled/codex/prompt";
import { composeBase } from "./compose";
import { FRAME, saved } from "./fixtures/saved";
import { type Facts, SECTIONS } from "./index";

const VARIANTS: readonly (readonly [string, Facts])[] = [
  ["default", {}],
  ["own-folder", { ownFolder: FRAME.workspace }],
];

describe("the prompt, byte for byte what it was before sections", () => {
  // Claude Code, Goose and Pi build theirs with `systemPrompt`.
  for (const scope of ["thread", "channel"] as const) {
    it(`for a ${scope} session`, () => {
      expect(
        `${systemPrompt({ scope, ...FRAME.system, cwd: FRAME.workspace })}\n`,
      ).toBe(saved(`system.${scope}.default`));
    });

    it(`for a ${scope} session in a folder of its own`, () => {
      expect(
        `${systemPrompt({
          scope,
          ...FRAME.system,
          cwd: FRAME.folder,
          workspace: FRAME.workspace,
        })}\n`,
      ).toBe(saved(`system.${scope}.own-folder`));
    });
  }

  it("for Codex", () => {
    const { agent } = FRAME.system;
    expect(`${developerInstructions(agent)}\n`).toBe(saved("codex.default"));
    expect(`${developerInstructions(agent, FRAME.workspace)}\n`).toBe(
      saved("codex.own-folder"),
    );
  });
});

describe("composeBase", () => {
  it.each(VARIANTS)(
    "prints each locked section once, in order (%s)",
    (_, facts) => {
      const { text } = composeBase(facts);
      let from = 0;
      for (const section of SECTIONS) {
        if (typeof section.text !== "string") continue;
        const locked = section.text.trim();
        const at = text.indexOf(locked, from);
        expect(at, section.id).toBeGreaterThanOrEqual(from);
        expect(text.indexOf(locked, at + 1), section.id).toBe(-1);
        from = at + locked.length;
      }
    },
  );

  it("gives each section an id of its own", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("names the workspace exactly as given", () => {
    // `$&` and `$1` mean something to a string replacement.
    const { text } = composeBase({ ownFolder: "/home/$&/$1/ws" });
    expect(text).toContain("Your persistent workspace is at `/home/$&/$1/ws`,");
    expect(text).not.toContain("{workspace}");
  });
});
