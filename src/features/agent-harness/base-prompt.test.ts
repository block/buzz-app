import { expect, it } from "vitest";
import { basePrompt } from "./base-prompt";

it("fills each harness part into the shared base prompt", () => {
  const prompt = basePrompt({
    turns: "TURNS",
    final: "FINAL",
    silence: "**SILENCE.**\n",
    acknowledgement: "ACK",
  });
  expect(prompt).not.toMatch(/\{\{|\}\}/);
  expect(prompt).toMatch(/^You are an agent operating inside Buzz/);
  expect(prompt).toContain("## Incoming Turn Contract\n\nTURNS\n\n");
  expect(prompt).toContain("\n\nFINAL\n\n");
  expect(prompt).toContain("\n- **SILENCE.**\n");
  expect(prompt).toContain("and any variation. ACK\n");
});
