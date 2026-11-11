import { expect, it, vi } from "vitest";
import type { Agent } from "../../../features/agents/service";
import type { BuilderlabSession } from "../session";
import { approveRequested, rejectRequested } from "./approve";
import type { AgentClient, RemoteAgent } from "./client";

const signal = new AbortController().signal;
const requested: RemoteAgent = {
  id: "two",
  name: "Scout",
  pubkey: "cd".repeat(32),
  status: "Unattested",
  requestedBy: "ab".repeat(32),
  instructions: "Watch the build.",
};
const session = {
  credential: () => ({ account: { subject: "user" } }),
} as unknown as BuilderlabSession;
const recommended = { modelId: "fast", reasoningEffort: "low" };
function fixture() {
  const client = {
    modelCatalog: vi.fn(async () => ({ models: [], recommended })),
    delete: vi.fn(async () => {}),
  };
  const agents = {
    adopt: vi.fn(async () => ({}) as Agent),
    find: vi.fn((): Agent | undefined => undefined),
    remove: vi.fn(async () => {}),
  };
  return { client, agents };
}

it("adopts the listed agent on Builderlab's default model with the reviewed instructions", async () => {
  const { client, agents } = fixture();
  await approveRequested(
    client as unknown as AgentClient,
    session,
    agents,
    requested,
    "Watch the build. Nightly.",
    signal,
  );
  expect(agents.adopt).toHaveBeenCalledExactlyOnceWith({
    type: "block.builderlab/builderlab",
    name: "Scout",
    pubkey: requested.pubkey,
    config: {
      instructions: "Watch the build. Nightly.",
      ...recommended,
      subject: "user",
    },
  });
});

it("keeps a valid model the request already has", async () => {
  const { client, agents } = fixture();
  await approveRequested(
    client as unknown as AgentClient,
    session,
    agents,
    {
      ...requested,
      modelId: "deep",
      reasoningEffort: "high",
      modelSelectionStatus: "valid",
    },
    "Watch the build.",
    signal,
  );
  expect(client.modelCatalog).not.toHaveBeenCalled();
  expect(agents.adopt).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        modelId: "deep",
        reasoningEffort: "high",
      }),
    }),
  );
});

it("does not adopt without a model to use", async () => {
  const { client, agents } = fixture();
  client.modelCatalog.mockResolvedValueOnce({ models: [] } as never);
  await expect(
    approveRequested(
      client as unknown as AgentClient,
      session,
      agents,
      requested,
      "",
      signal,
    ),
  ).rejects.toThrow("no default model");
  expect(agents.adopt).not.toHaveBeenCalled();
});

it("rejects by deleting the registration, or through Agents once it keeps the agent", async () => {
  const { client, agents } = fixture();
  await rejectRequested(
    client as unknown as AgentClient,
    agents,
    requested,
    signal,
  );
  expect(client.delete).toHaveBeenCalledWith(requested, signal);
  expect(agents.remove).not.toHaveBeenCalled();
  agents.find.mockReturnValueOnce({ pubkey: requested.pubkey } as Agent);
  await rejectRequested(
    client as unknown as AgentClient,
    agents,
    requested,
    signal,
  );
  expect(agents.remove).toHaveBeenCalledExactlyOnceWith(requested.pubkey);
  expect(client.delete).toHaveBeenCalledTimes(1);
});
