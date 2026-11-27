// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { ModelUnavailable } from "./ModelUnavailable";
import type { RecommendedCandidate } from "./recommended";
import type { Agent, AgentChange, Model, Models } from "./service";

afterEach(cleanup);

const PUBKEY = "a".repeat(64);
const FAILED = "databricks-retired-model";

const DEFAULT_MODELS: readonly Model[] = [
  { id: FAILED, label: FAILED, efforts: [] },
  { id: "databricks-claude-opus-9", label: "Claude Opus 9", efforts: [] },
];

function setup({
  current = FAILED,
  place = "here",
  author = PUBKEY,
  config = { provider: "", model: "", instructions: "Be kind" },
  catalog = DEFAULT_MODELS,
  recommended,
}: {
  current?: string;
  place?: Agent["place"];
  author?: string;
  config?: Record<string, unknown>;
  catalog?: readonly Model[];
  recommended?: RecommendedCandidate | null;
} = {}) {
  let agent = {
    key: `${PUBKEY}:wss://relay.test`,
    pubkey: PUBKEY,
    name: "Fizz",
    type: "buzz.goose/goose",
    place,
    config,
  } as unknown as Agent;
  const listeners = new Set<() => void>();
  let snapshot = { agents: [agent] };
  const models = vi.fn(
    async (): Promise<Models> => ({
      current: (agent.config as { model?: string }).model || current,
      models: catalog,
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
    types: () => [
      {
        key: "buzz.goose/goose",
        id: "goose",
        models,
        ...(recommended !== undefined && {
          settingsProposal: { resolveRecommended: async () => recommended },
        }),
      },
    ],
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

it("clears an incompatible thinking effort and keeps a supported one on model pick", async () => {
  const user = userEvent.setup();
  const catalog: readonly Model[] = [
    { id: FAILED, label: FAILED, efforts: [{ id: "max", label: "Max" }] },
    {
      id: "claude-sonnet-9",
      label: "Claude Sonnet 9",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "claude-opus-9",
      label: "Claude Opus 9",
      efforts: [
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
  ];
  const { save } = setup({
    config: { model: FAILED, effort: "max", instructions: "Be kind" },
    catalog,
  });
  await user.click(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  );
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: /Sonnet 9/ }),
  );
  expect(save).toHaveBeenLastCalledWith(`${PUBKEY}:wss://relay.test`, {
    config: {
      model: "claude-sonnet-9",
      effort: "",
      instructions: "Be kind",
    },
  });

  cleanup();
  const kept = setup({
    config: { model: FAILED, effort: "max", instructions: "Be kind" },
    catalog,
  });
  await user.click(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  );
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: /Opus 9/ }),
  );
  expect(kept.save).toHaveBeenLastCalledWith(`${PUBKEY}:wss://relay.test`, {
    config: {
      model: "claude-opus-9",
      effort: "max",
      instructions: "Be kind",
    },
  });
});

it("preserves the recommended provider when taking a Recommended agent off Recommended", async () => {
  const user = userEvent.setup();
  const { save } = setup({
    config: { preset: "recommended", instructions: "Be kind" },
    recommended: {
      harness: "goose",
      provider: "databricks",
      model: FAILED,
      effort: "high",
      label: "Retired",
    },
  });
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
      instructions: "Be kind",
      provider: "databricks",
      model: "databricks-claude-opus-9",
    },
  });
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
