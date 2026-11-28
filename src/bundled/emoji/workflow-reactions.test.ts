import { expect, it } from "vitest";
import { stringify } from "yaml";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { workflowReactions } from "./workflow-reactions";

const channelId = "11111111-1111-4111-8111-111111111111";
const definition = (
  config: unknown,
  channel = channelId,
): WorkflowDefinition => ({
  id: "22222222-2222-4222-8222-222222222222",
  owner: "ab".repeat(32),
  revision: "cd".repeat(32),
  channelId: channel,
  createdAt: 1,
  yaml: stringify(config),
});
const step = (id: string, emoji: string, name?: string) => ({
  id,
  action: "send_message",
  if: `trigger_emoji == "${emoji}"`,
  name,
});

it("lists exact reaction branches, groups actions, and preserves custom and skin-tone literals", () => {
  const result = workflowReactions(
    [
      definition({
        name: "Triage",
        trigger: { on: "reaction_added" },
        steps: [
          step("review_complete", "✅", "Review complete"),
          step("notify", "✅"),
          step("custom", ":party:"),
          step("hand", "🫸"),
          step("tone", "🫸🏽"),
        ],
      }),
    ],
    channelId,
  );
  expect(result).toEqual({
    incomplete: false,
    items: [
      { emoji: "✅", labels: ["Triage — Review complete", "Triage — notify"] },
      { emoji: ":party:", labels: ["Triage — custom"] },
      { emoji: "🫸", labels: ["Triage — hand"] },
      { emoji: "🫸🏽", labels: ["Triage — tone"] },
    ],
  });
});

it("discovers declared emoji and exact trigger filters without promising conditional execution", () => {
  const result = workflowReactions(
    [
      definition({
        name: "Notify",
        trigger: { on: "reaction_added", emoji: "🎉" },
        steps: [
          {
            id: "send",
            action: "send_message",
            if: 'trigger_author == "other"',
          },
        ],
      }),
      definition({
        name: "Review",
        trigger: { on: "reaction_added", filter: 'trigger_emoji == "✅"' },
        steps: [{ id: "send", action: "send_message" }],
      }),
    ],
    channelId,
  );
  expect(result).toEqual({
    incomplete: true,
    items: [
      { emoji: "🎉", labels: ["Notify"] },
      { emoji: "✅", labels: ["Review"] },
    ],
  });
});

it("does not leak other channels, disabled definitions or non-reaction workflows", () => {
  const config = {
    name: "Notify",
    trigger: { on: "reaction_added", emoji: "🎉" },
    steps: [{ id: "send", action: "send_message" }],
  };
  expect(
    workflowReactions(
      [
        definition(config, "33333333-3333-4333-8333-333333333333"),
        definition({ ...config, enabled: false }),
        definition({ ...config, trigger: { on: "message_posted" } }),
        definition({
          ...config,
          trigger: { on: "reaction_added", filter: "false" },
        }),
      ],
      channelId,
    ),
  ).toEqual({ items: [], incomplete: false });
});

it("does not evaluate or guess complex expressions or turn malformed YAML into shortcuts", () => {
  const config = {
    name: "Notify",
    trigger: { on: "reaction_added" },
    steps: [
      {
        id: "send",
        action: "send_message",
        if: 'trigger_emoji == "✅" || true',
      },
    ],
  };
  expect(
    workflowReactions(
      [
        definition(config),
        { ...definition(config), yaml: "[malformed" },
        definition({ ...config, steps: [step("not_an_emoji", "plain text")] }),
        definition({ ...config, steps: [step("not_one_reaction", "✅🎉")] }),
      ],
      channelId,
    ),
  ).toEqual({ items: [], incomplete: true });
});
