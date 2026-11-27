// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  listModels,
}: {
  current?: string;
  place?: Agent["place"];
  author?: string;
  config?: Record<string, unknown>;
  catalog?: readonly Model[];
  recommended?: RecommendedCandidate | null;
  listModels?: (agent: Agent) => Promise<Models>;
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
    async (listedAgent: Agent): Promise<Models> =>
      listModels
        ? listModels(listedAgent)
        : {
            current: (agent.config as { model?: string }).model || current,
            models: catalog,
          },
  );
  const updateConfig = (next: Record<string, unknown>) => {
    agent = { ...agent, config: next };
    snapshot = { agents: [agent] };
    for (const listener of listeners) listener();
  };
  const save = vi.fn(async (_key: string, change: AgentChange) => {
    updateConfig(change.config as Record<string, unknown>);
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
  return { save, updateConfig };
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

it("matches a model alias against the concrete failed provider ID and excludes it from choices", async () => {
  const user = userEvent.setup();
  const { save } = setup({
    config: { model: "opus", instructions: "Be kind" },
    current: "opus",
    catalog: [
      {
        id: "opus",
        label: "Opus 5.5",
        resolvedModel: FAILED,
        efforts: [],
      },
      {
        id: "sonnet",
        label: "Sonnet 5.5",
        resolvedModel: "claude-sonnet-5-5",
        efforts: [],
      },
    ],
  });
  await user.click(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  );
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.queryByRole("menuitemradio", { name: /Opus 5\.5/ })).toBeNull();
  await user.click(
    await screen.findByRole("menuitemradio", { name: /Sonnet 5\.5/ }),
  );
  expect(save).toHaveBeenCalledWith(`${PUBKEY}:wss://relay.test`, {
    config: { model: "sonnet", instructions: "Be kind" },
  });
});

it("withholds stale choices while a new provider's catalog is still loading", async () => {
  const user = userEvent.setup();
  let resolveNext: ((value: Models) => void) | undefined;
  const { save, updateConfig } = setup({
    config: { provider: "openai", model: FAILED, instructions: "Be kind" },
    listModels: (listedAgent) => {
      const { provider } = listedAgent.config as { provider: string };
      if (provider === "openai")
        return Promise.resolve({
          current: FAILED,
          models: [
            { id: FAILED, label: FAILED, efforts: [] },
            { id: "gpt-5", label: "GPT-5", efforts: [] },
          ],
        });
      return new Promise<Models>((resolve) => {
        resolveNext = resolve;
      });
    },
  });
  // Before a pick: switching providers hides the previous provider's menu until
  // the new provider's catalog arrives.
  expect(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  ).toBeVisible();
  act(() => {
    updateConfig({
      provider: "databricks",
      model: FAILED,
      instructions: "Be kind",
    });
  });
  expect(screen.queryByRole("button", { name: /^Model for Fizz:/ })).toBeNull();
  expect(save).not.toHaveBeenCalled();

  await act(async () => {
    resolveNext?.({
      current: FAILED,
      models: [
        { id: FAILED, label: FAILED, efforts: [] },
        { id: "databricks-claude-opus-9", label: "Claude Opus 9", efforts: [] },
      ],
    });
  });
  await user.click(
    await screen.findByRole("button", { name: /^Model for Fizz:/ }),
  );
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.queryByRole("menuitemradio", { name: /GPT-5/ })).toBeNull();
  await user.click(
    await screen.findByRole("menuitemradio", { name: /Opus 9/ }),
  );
  expect(save).toHaveBeenCalledWith(`${PUBKEY}:wss://relay.test`, {
    config: {
      provider: "databricks",
      model: "databricks-claude-opus-9",
      instructions: "Be kind",
    },
  });

  // After a pick: switching providers again disables the menu while the new
  // catalog is in flight so stale models cannot be saved into the new provider.
  act(() => {
    updateConfig({
      provider: "anthropic",
      model: "databricks-claude-opus-9",
      instructions: "Be kind",
    });
  });
  const button = await screen.findByRole("button", {
    name: /^Model for Fizz:/,
  });
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAttribute("aria-busy", "true");
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
