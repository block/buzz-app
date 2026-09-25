import { describe, expect, it } from "vitest";

import { workflowCardPresentation } from "./workflowCardPresentation";

describe("workflowCardPresentation", () => {
  it("describes supported triggers and actions", () => {
    expect(
      workflowCardPresentation(`
trigger:
  on: reaction_added
  emoji: "👍"
steps:
  - id: pause
    action: delay
  - id: reply
    action: send_message
`),
    ).toEqual({
      actionIcons: [
        { icon: "delay", key: "pause" },
        { icon: "message", key: "reply" },
      ],
      description: "When a reaction is added, wait and send a message.",
      triggerEmoji: "👍",
      triggerIcon: "reaction",
    });
  });

  it("keeps unsupported and malformed definitions legible", () => {
    expect(
      workflowCardPresentation(`
trigger:
  on: custom_event
steps:
  - id: custom
    action: custom_action
`),
    ).toMatchObject({
      actionIcons: [{ icon: "workflow", key: "custom" }],
      description: "When its trigger matches, run an action.",
      triggerIcon: "workflow",
    });
    expect(workflowCardPresentation("trigger: [")).toMatchObject({
      actionIcons: [],
      description: "Review this workflow configuration.",
      triggerIcon: "workflow",
    });
  });
});
