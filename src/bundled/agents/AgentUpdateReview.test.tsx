import { expect, it } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import {
  enqueueManagementRequest,
  managementRequesterAuthorized,
  matchingManagementAgents,
  type PendingManagementRequest,
  requestedDraft,
} from "./AgentUpdateReview";

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

const pending = (
  requestId: string,
  agent = "a".repeat(64),
): PendingManagementRequest => ({
  agent,
  value: {
    type: "agent_management_request" as const,
    action: "update" as const,
    requestId,
    request: {
      channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
      agentName: "Fixture agent",
      model: "gpt-6-sol",
    },
  },
});

it("matches only configured personal agents in the request community", () => {
  const { agent } = controlFixture();
  const request = pending("request-1", agent.pubkey);
  expect(
    matchingManagementAgents(
      [
        agent,
        {
          ...agent,
          id: "other-community",
          relayUrl: "wss://other.example.test",
        },
        {
          ...agent,
          id: "same-community-other-owner",
          pubkey: "cd".repeat(32),
        },
        {
          ...agent,
          id: "unconfigured",
          configured: false,
          relayUrl: "",
        },
        {
          ...agent,
          id: "invalid-community",
          relayUrl: "not a relay URL",
        },
      ],
      request,
      "https://relay.example.test",
    ).map(({ id }) => id),
  ).toEqual(["fixture-agent"]);
});

it("queues requests received while another review is open and bounds the queue", () => {
  let requests = [pending("open")];
  requests = enqueueManagementRequest(requests, pending("next"));
  expect(requests.map(({ value }) => value.requestId)).toEqual([
    "open",
    "next",
  ]);

  for (let index = 0; index < 200; index++)
    requests = enqueueManagementRequest(requests, pending(`request-${index}`));
  expect(requests).toHaveLength(200);
  expect(requests[0]?.value.requestId).toBe("request-0");
});

it("waits for a ready roster before authorizing the requester", () => {
  const request = pending("request-1");
  expect(
    managementRequesterAuthorized(request, {
      status: "loading",
      channels: [],
    }),
  ).toBeNull();
  expect(
    managementRequesterAuthorized(request, {
      status: "ready",
      channels: [
        {
          id: request.value.request.channelId,
          name: "Project",
          members: [request.agent],
        },
      ],
    }),
  ).toBe(true);
});
