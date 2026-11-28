import { describe, expect, it } from "vitest";
import type { AgentHandle } from "../agents/service";
import { type WakeTrigger, wakePrompt } from "./wakes";

const objects: Record<string, unknown> = {
  "watch/daily": {
    type: "timer",
    id: "daily",
    interest_id: "ops",
    prompt: "Run daily",
  },
  "interest/ops": { type: "interest", instructions: "Report in #ops." },
};
const agent = {
  attention: {
    show: async (slug: string) => ({ object: objects[slug] ?? null }),
  },
  instructions: () => [{ plugin: "acme.dibs", text: "Run dibs_check." }],
} as unknown as AgentHandle;
const trigger = {
  type: "timer",
  slug: "watch/daily",
  spent: false,
} as unknown as WakeTrigger;

describe("wakePrompt", () => {
  it("leaves plugin instructions and the Attention review to the conversation turn", async () => {
    const anchored = await wakePrompt(agent, trigger, "daily", () => true);
    expect(anchored).toContain("Run daily");
    expect(anchored).not.toContain("<plugin-instructions");
    expect(anchored).not.toContain("<attention>");
    const standalone = await wakePrompt(agent, trigger, "daily", () => true, {
      standalone: true,
    });
    expect(standalone?.match(/<plugin-instructions /g)).toHaveLength(1);
    expect(standalone).toMatch(/<\/plugin-instructions>\n\n<attention>/);
  });
});
