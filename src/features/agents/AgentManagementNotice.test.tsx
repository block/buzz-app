import { expect, it } from "vitest";
import { controlFixture } from "./control-testing";
import { requestedDraft } from "./AgentManagementNotice";

it("prefills only requested update fields over current saved settings", () => {
  const { agent } = controlFixture();
  expect(
    requestedDraft(agent, {
      type: "agent_management_request",
      action: "update",
      requestId: "request-1",
      request: {
        channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
        agentName: "Fixture agent",
        model: "gpt-6-sol",
      },
    }),
  ).toMatchObject({
    name: "Fixture agent",
    systemPrompt: "Help with the project.",
    command: "fixture-acp",
    provider: "fixture-provider",
    model: "gpt-6-sol",
  });
});
