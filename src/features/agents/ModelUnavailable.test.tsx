// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { ModelUnavailable } from "./ModelUnavailable";
import type { Agent, AgentChange, Models } from "./service";

afterEach(cleanup);

const PUBKEY = "a".repeat(64);
const FAILED = "databricks-retired-model";

function setup({
  current = FAILED,
  place = "here",
  author = PUBKEY,
}: {
  current?: string;
  place?: Agent["place"];
  author?: string;
} = {}) {
  let agent = {
    key: `${PUBKEY}:wss://relay.test`,
    pubkey: PUBKEY,
    name: "Fizz",
    type: "buzz.goose/goose",
    place,
    config: { provider: "", model: "", instructions: "Be kind" },
  } as unknown as Agent;
  const listeners = new Set<() => void>();
  let snapshot = { agents: [agent] };
  const models = vi.fn(
    async (): Promise<Models> => ({
      current: (agent.config as { model: string }).model || current,
      models: [
        { id: FAILED, label: FAILED, efforts: [] },
        { id: "databricks-claude-opus-9", label: "Claude Opus 9", efforts: [] },
      ],
    }),
  );
  const save = vi.fn(async (_key: string, change: AgentChange) => {
    agent = { ...agent, config: change.config };
    snapshot = { agents: [agent] };
    for (const listener of listeners) listener();
  });
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    find: (pubkey: string) => (pubkey === PUBKEY ? agent : undefined),
    types: () => [{ key: "buzz.goose/goose", id: "goose", models }],
    save,
  } as unknown as Parameters<typeof ModelUnavailable>[0]["agents"];
  const message = {
    id: "m1",
    authorId: author,
    modelUnavailable: FAILED,
  } as unknown as ChannelMessage;
  render(<ModelUnavailable agents={agents} message={message} />);
  return { save };
}

it("lets the owner pick another model for the agent, saved to its own settings", async () => {
  const user = userEvent.setup();
  const { save } = setup();
  await user.click(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  );
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: /Opus 9/ }),
  );
  expect(save).toHaveBeenCalledWith(`${PUBKEY}:wss://relay.test`, {
    config: {
      provider: "",
      model: "databricks-claude-opus-9",
      instructions: "Be kind",
    },
  });
  expect(
    await screen.findByText("Fizz uses this model from now on."),
  ).toBeVisible();
});

it.each([
  ["another person's agent", { author: "b".repeat(64) }],
  ["an agent on another device", { place: "elsewhere" as const }],
  ["an agent that no longer runs on that model", { current: "other-model" }],
])("offers nothing for %s", async (_, options) => {
  setup(options);
  // Its models are listed asynchronously; let that settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("button", { name: /^Model for/ })).toBeNull();
});
