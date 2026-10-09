import type { ControlSnapshot } from "../../features/agents/control";
import { expect, it, vi } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import {
  enqueueManagementRequest,
  managementRequesterAuthorized,
  matchingManagementAgents,
  refreshManagementInventory,
  type PendingManagementRequest,
  requestedDraft,
} from "./AgentUpdateReview";

it("prefills only requested update fields over current saved settings", () => {
  const { agent } = controlFixture();
  expect(
    requestedDraft(
      agent,
      {
        type: "agent_management_request",
        action: "update",
        requestId: "request-1",
        request: {
          channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
          agentName: "Fixture agent",
          model: "gpt-6-sol",
        },
      },
      [],
    ),
  ).toMatchObject({
    name: "Fixture agent",
    systemPrompt: "Help with the project.",
    command: "fixture-acp",
    provider: "fixture-provider",
    model: "gpt-6-sol",
  });
});

it("resolves requested runtime IDs through installed harness options", () => {
  const { agent } = controlFixture();
  const harnessOptions: NonNullable<ControlSnapshot["harnessOptions"]> = [
    {
      command: "/opt/homebrew/bin/goose",
      label: "Goose",
      defaultArgs: ["acp"],
      providers: [],
    },
  ];
  expect(
    requestedDraft(
      agent,
      {
        type: "agent_management_request",
        action: "update",
        requestId: "request-1",
        request: {
          channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
          agentName: "Fixture agent",
          runtime: "goose",
        },
      },
      harnessOptions,
    ),
  ).toMatchObject({
    command: "/opt/homebrew/bin/goose",
    args: '["acp"]',
  });
});

it("moves Codex-owned settings with requested runtime switches", () => {
  const { agent } = controlFixture();
  const harnessOptions: NonNullable<ControlSnapshot["harnessOptions"]> = [
    {
      id: "goose",
      command: "/opt/homebrew/bin/goose",
      label: "Goose",
      defaultArgs: [],
      providers: [],
    },
    {
      id: "codex",
      command: "/tools/codex-acp",
      label: "Codex",
      defaultArgs: [],
      providers: [],
    },
  ];
  const codexAgent = {
    ...agent,
    harness: {
      ...agent.harness,
      command: "/tools/codex-acp",
      args: [],
      provider: "",
      model: "gpt-5.5",
      integration: "codex" as const,
      configuration: {
        mode: "advanced" as const,
        effort: { kind: "value" as const, value: "high" },
      },
    },
  };
  const request = (runtime: string) =>
    ({
      type: "agent_management_request",
      action: "update",
      requestId: "request-1",
      request: {
        channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
        agentName: "Fixture agent",
        runtime,
      },
    }) as const;

  const toGoose = requestedDraft(codexAgent, request("goose"), harnessOptions);
  expect(toGoose).toMatchObject({
    command: "/opt/homebrew/bin/goose",
    model: "",
  });
  expect(toGoose.integration).toBeUndefined();
  expect(toGoose.configuration).toBeUndefined();

  expect(
    requestedDraft(agent, request("codex-acp"), harnessOptions),
  ).toMatchObject({
    command: "/tools/codex-acp",
    args: "[]",
    integration: "codex",
    configuration: { mode: "default" },
    provider: "",
    model: "",
  });

  expect(
    requestedDraft(codexAgent, request("codex-acp"), harnessOptions),
  ).toMatchObject({
    integration: "codex",
    configuration: { mode: "advanced", effort: { value: "high" } },
    model: "gpt-5.5",
  });
});

it("requires a successful inventory snapshot before review", async () => {
  const refresh = vi.fn(async () => {});
  expect(
    await refreshManagementInventory({
      refresh,
      snapshot: () => ({
        status: "error",
        data: null,
        busy: false,
        error: "Could not refresh",
      }),
    } as never),
  ).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
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

it("follows a selected ID through rename while preserving authorization checks", () => {
  const { agent } = controlFixture();
  const request = pending("request-1", agent.pubkey);
  const renamed = { ...agent, name: "Renamed agent" };
  const match = (candidate: typeof agent) =>
    matchingManagementAgents(
      [candidate],
      request,
      "https://relay.example.test",
      agent.id,
    );
  expect(match(renamed)).toEqual([renamed]);
  expect(match({ ...renamed, id: "replacement" })).toEqual([]);
  expect(match({ ...renamed, pubkey: "cd".repeat(32) })).toEqual([]);
  expect(match({ ...renamed, relayUrl: "wss://other.example.test" })).toEqual(
    [],
  );
  expect(match({ ...renamed, configured: false })).toEqual([]);
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
  expect(requests[0]?.value.requestId).toBe("open");
  expect(requests[1]?.value.requestId).toBe("request-1");
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
      channels: [],
      coverage: "partial",
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
