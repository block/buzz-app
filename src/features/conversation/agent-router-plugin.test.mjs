import { expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { createAgentRouting } from "./agent-routing";
import { apply } from "../../../examples/plugins/agent-router/plugin.js";

const a = "1".repeat(64),
  b = "2".repeat(64),
  c = "3".repeat(64);
const request = {
  text: "Check my calendar",
  channelId: "chat",
  community: "https://relay.example.org",
  context: [],
  candidates: [a, b, c].map((pubkey) => ({
    pubkey,
    name: pubkey,
    description: "Assistant",
  })),
};
function setup(
  reply,
  agents = { snapshot: () => ({ agents: [] }), types: () => [] },
) {
  let router;
  const accessory = vi.fn();
  const decide = vi.fn(async () => reply);
  apply({
    conversation: {
      registerAccessory: accessory,
      registerAgentRouter: (value) => {
        router = value;
      },
    },
    decisions: { decide },
    agents,
  });
  return { router, decide, accessory };
}
it("does not add routing status or other composer UI", async () => {
  const h = setup({
    outcome: "answered",
    answers: { assignment: { type: "choice", choice: "all", confidence: 1 } },
  });
  await h.router.route(request);
  expect(h.accessory).not.toHaveBeenCalled();
});
it("uses the comparative single-agent choice even when every independent assignment score is low", async () => {
  const h = setup({
    outcome: "answered",
    answers: {
      assignment: { type: "choice", choice: "agent_0", confidence: 0.95 },
      group_0: { type: "yes_no", probability: 0.58 },
      group_1: { type: "yes_no", probability: 0.1 },
      group_2: { type: "yes_no", probability: 0.01 },
    },
  });
  expect(
    await h.router.route({
      ...request,
      text: "how does my calendar look like tomorrow?",
    }),
  ).toEqual([a]);
});
it("keeps the all-agent fallback when the comparative choice is uncertain", async () => {
  const h = setup({
    outcome: "answered",
    answers: {
      assignment: { type: "choice", choice: "agent_0", confidence: 0.69 },
      group_0: { type: "yes_no", probability: 0.99 },
    },
  });
  expect(await h.router.route(request)).toEqual([a, b, c]);
});
it("supplies selected agents' readable role instructions without forwarding raw configuration", async () => {
  const carry = vi.fn((config) => ({ instructions: config.instructions }));
  const h = setup(
    {
      outcome: "answered",
      answers: { assignment: { type: "choice", choice: "all", confidence: 1 } },
    },
    {
      snapshot: () => ({
        agents: [
          {
            pubkey: a,
            relay: "wss://relay.example.org",
            type: "example/assistant",
            config: {
              instructions: "Use mcp_budget for marketing budgets.",
              apiKey: "must-not-forward",
            },
          },
          {
            pubkey: b,
            relay: "https://other.example.org",
            type: "example/assistant",
            config: { instructions: "Other community only" },
          },
          {
            pubkey: c,
            relay: request.community,
            type: "example/assistant",
            configProblem: "Unavailable",
            config: { instructions: "Stale instructions" },
          },
          {
            pubkey: "4".repeat(64),
            relay: request.community,
            type: "example/assistant",
            config: { instructions: "Unselected agent" },
          },
        ],
      }),
      types: () => [{ key: "example/assistant", carry }],
    },
  );
  await h.router.route({ ...request, text: "Use mcp_budget" });
  const state = JSON.parse(h.decide.mock.calls[0][0].state);
  expect(state.candidates).toEqual([
    {
      ...request.candidates[0],
      id: "agent_0",
      instructions: "Use mcp_budget for marketing budgets.",
    },
    { ...request.candidates[1], id: "agent_1" },
    { ...request.candidates[2], id: "agent_2" },
  ]);
  expect(carry).toHaveBeenCalledOnce();
  expect(h.decide.mock.calls[0][0].state).not.toContain("must-not-forward");
});
it("bounds saved instructions and tolerates a type that cannot read them", async () => {
  const h = setup(
    {
      outcome: "answered",
      answers: { assignment: { type: "choice", choice: "all", confidence: 1 } },
    },
    {
      snapshot: () => ({
        agents: [a, b, c].map((pubkey) => ({
          pubkey,
          relay: request.community,
          type: pubkey,
          config: {},
        })),
      }),
      types: () => [
        { key: a, carry: () => ({ instructions: "x".repeat(20_000) }) },
        {
          key: b,
          carry: () => {
            throw new Error("Unreadable");
          },
        },
      ],
    },
  );
  await h.router.route(request);
  const state = JSON.parse(h.decide.mock.calls[0][0].state);
  expect(state.candidates[0].instructions).toHaveLength(Math.floor(16_000 / 3));
  expect(state.candidates[1].instructions).toBeUndefined();
  expect(state.candidates[2].instructions).toBeUndefined();
});
it.each([[a], [a, c], [a, b, c]])(
  "assigns one, several or all agents in one decision: %j",
  async (...selected) => {
    const h = setup({
      outcome: "answered",
      answers: {
        assignment: {
          type: "choice",
          choice:
            selected.length === 3
              ? "all"
              : selected.length === 1
                ? "agent_0"
                : "set_5",
          confidence: 1,
        },
        ...Object.fromEntries(
          [a, b, c].map((key, i) => [
            `group_${i}`,
            {
              type: "yes_no",
              probability: selected.includes(key) ? 0.99 : 0.01,
            },
          ]),
        ),
      },
    });
    expect(await h.router.route(request)).toEqual(selected);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(Object.keys(h.decide.mock.calls[0][0].questions)).toHaveLength(1);
    expect(
      Object.keys(h.decide.mock.calls[0][0].questions.assignment.options),
    ).toHaveLength(7);
    expect(h.decide.mock.calls[0][0].community).toBe(request.community);
  },
);
it("starts every selected agent for collaborative work even when individual relevance selects only one", async () => {
  const h = setup({
    outcome: "answered",
    answers: {
      assignment: { type: "choice", choice: "all", confidence: 0.9 },
      group_0: { type: "yes_no", probability: 0.99 },
      group_1: { type: "yes_no", probability: 0.01 },
      group_2: { type: "yes_no", probability: 0.01 },
    },
  });
  expect(
    await h.router.route({
      ...request,
      text: "Work together on a plan, exchange drafts, review each other's work and combine the result.",
    }),
  ).toEqual([a, b, c]);
  expect(h.decide).toHaveBeenCalledOnce();
});
it("defaults to all selected agents when the provider fails or returns malformed answers", async () => {
  for (const reply of [
    { outcome: "failed", reason: "missing_credentials" },
    { outcome: "failed", reason: "timeout" },
    { outcome: "answered", answers: {} },
  ]) {
    expect(await setup(reply).router.route(request)).toEqual([a, b, c]);
  }
});
it.each(["snapshot", "types"])(
  "continues routing without instructions when the optional %s read fails",
  async (operation) => {
    const agents = {
      snapshot: () => ({ agents: [] }),
      types: () => [],
      [operation]: () => {
        throw new Error("Unavailable agent settings");
      },
    };
    const h = setup(
      {
        outcome: "answered",
        answers: {
          assignment: { type: "choice", choice: "agent_0", confidence: 1 },
          group_0: { type: "yes_no", probability: 0.99 },
          group_1: { type: "yes_no", probability: 0.01 },
          group_2: { type: "yes_no", probability: 0.01 },
        },
      },
      agents,
    );
    expect(await h.router.route(request)).toEqual([a]);
    expect(h.decide).toHaveBeenCalledOnce();
  },
);
it("continues routing when a saved agent has a non-URL community identifier", async () => {
  const h = setup(
    {
      outcome: "answered",
      answers: { assignment: { type: "choice", choice: "all", confidence: 1 } },
    },
    {
      snapshot: () => ({
        agents: [
          {
            pubkey: a,
            relay: "legacy-community",
            type: "example/assistant",
            config: {},
          },
        ],
      }),
      types: () => [],
    },
  );
  expect(await h.router.route(request)).toEqual([a, b, c]);
  expect(h.decide).toHaveBeenCalledOnce();
});
it("defaults to all selected agents if a decision unexpectedly rejects", async () => {
  const h = setup(undefined);
  h.decide.mockRejectedValueOnce(new Error("Provider unavailable"));
  expect(await h.router.route(request)).toEqual([a, b, c]);
});
it.each([0.01, 0.5, 0.69])(
  "sends to all selected agents when the set choice is uncertain: %s",
  async (probability) => {
    const h = setup({
      outcome: "answered",
      answers: {
        assignment: {
          type: "choice",
          choice: "agent_0",
          confidence: probability,
        },
        ...Object.fromEntries(
          [a, b, c].map((_, i) => [
            `group_${i}`,
            { type: "yes_no", probability },
          ]),
        ),
      },
    });
    expect(
      await h.router.route({
        ...request,
        text: "how does my calendar look like?",
      }),
    ).toEqual([a, b, c]);
    expect(h.decide).toHaveBeenCalledOnce();
  },
);
it.each([
  ["agent_0", [a]],
  ["agent_1", [b]],
  ["agent_2", [c]],
  ["set_3", [a, b]],
  ["set_5", [a, c]],
  ["set_6", [b, c]],
  ["all", [a, b, c]],
])(
  "maps the complete subset choice %s back to its exact recipients",
  async (choice, expected) => {
    const h = setup({
      outcome: "answered",
      answers: { assignment: { type: "choice", choice, confidence: 0.99 } },
    });
    expect(
      await h.router.route({
        ...request,
        candidates: [...request.candidates].reverse(),
      }),
    ).toEqual(expected);
    expect(h.decide).toHaveBeenCalledOnce();
  },
);
it("offers all 255 nonempty subsets at the eight-agent limit", async () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    pubkey: i.toString(16).padStart(64, "0"),
    name: `Agent ${i}`,
    description: "",
  }));
  const h = setup({
    outcome: "answered",
    answers: {
      assignment: { type: "choice", choice: "set_129", confidence: 0.99 },
    },
  });
  expect(await h.router.route({ ...request, candidates })).toEqual([
    candidates[0].pubkey,
    candidates[7].pubkey,
  ]);
  expect(h.decide).toHaveBeenCalledOnce();
  const questions = h.decide.mock.calls[0][0].questions;
  expect(Object.keys(questions)).toEqual(["assignment"]);
  expect(Object.keys(questions.assignment.options)).toHaveLength(255);
});
it.each([9, 32])(
  "uses ordinary delivery for %s agents without reading instructions or calling JEV",
  async (count) => {
    const candidates = Array.from({ length: count }, (_, i) => ({
      pubkey: i.toString(16).padStart(64, "0"),
      name: `Agent ${i}`,
      description: "",
    })).reverse();
    const agents = { snapshot: vi.fn(), types: vi.fn() };
    const h = setup(undefined, agents);
    expect(await h.router.route({ ...request, candidates })).toEqual(
      candidates.map(({ pubkey }) => pubkey),
    );
    expect(agents.snapshot).not.toHaveBeenCalled();
    expect(agents.types).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  },
);
it("requires host support instead of appearing active while routing nothing", () => {
  expect(() => apply({ conversation: {} })).toThrow("pre-send agent routing");
});

it("the host accepts ordinary delivery after settings and decision failures", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
    settled: () => true,
  });
  const owner = root.extend({
    pluginOwner: { id: "example.agent-router", revision: "send-fix" },
  });
  const gate = createAgentRouting(root);
  apply({
    conversation: {
      registerAgentRouter: (router) => gate.register(router, owner),
      registerAccessory: () => {},
    },
    agents: {
      snapshot: () => {
        throw new Error("Settings unavailable");
      },
    },
    decisions: {
      decide: async () => {
        throw new Error("Provider unavailable");
      },
    },
  });
  try {
    expect(await gate.route(request, new AbortController().signal)).toEqual([
      a,
      b,
      c,
    ]);
  } finally {
    await root.fiber.dispose();
  }
});
