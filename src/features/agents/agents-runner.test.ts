import { expect, it, vi } from "vitest";
import { AgentsRunner, type RunnerManager } from "./agents-runner";
import { createLocalAgentActivity } from "./local-activity";
import type { Member } from "./records";
import { memoryStorage } from "./test-fakes";

const owner = "b".repeat(64);
const ada: Member = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  relay: "wss://relay.example",
  owner,
  type: "test/agent",
  name: "Ada",
  deleted: false,
};
const gone = "c".repeat(64);

function saved() {
  const storage = memoryStorage();
  for (const pubkey of [ada.pubkey, gone])
    storage.setItem(
      `buzz.agent.v1:${pubkey}`,
      JSON.stringify({ pubkey, attention: {}, config: {} }),
    );
  return storage;
}

function runner(storage: ReturnType<typeof memoryStorage>) {
  const manager = {
    ownershipChanged: () => {},
    open: () => undefined,
    types: () => [],
    defaults: () => {
      throw new Error("No types here");
    },
  } as unknown as RunnerManager;
  return new AgentsRunner(
    storage,
    undefined,
    createLocalAgentActivity(),
    undefined,
    manager,
  );
}

it("forgets records no membership keeps only once the whole list is read", async () => {
  const storage = saved();
  const agents = runner(storage);
  expect(agents.records.keys().sort()).toEqual([ada.pubkey, gone]);
  // Before native's list is read, an empty list names nobody.
  agents.members([], owner, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(agents.records.keys().sort()).toEqual([ada.pubkey, gone]);
  agents.members([ada], owner, true);
  await vi.waitFor(() => expect(agents.records.keys()).toEqual([ada.pubkey]));
  expect(storage.getItem(`buzz.agent.v1:${gone}`)).toBeNull();
  agents.clear();
});
