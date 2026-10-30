import { expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { registerDecideTool } from "./agent-tool";
import {
  checkRequest,
  type DecisionRequest,
  type DecisionResult,
  type Decisions,
} from "./service";

const AGENT = "a".repeat(64);
function setup(result: (request: DecisionRequest) => DecisionResult) {
  const addTool = vi.fn<(tool: AddedTool) => void>();
  const decide = vi.fn(async (request: DecisionRequest) => result(request));
  registerDecideTool(
    {
      addTool,
      snapshot: () => ({
        running: [{ key: AGENT, relay: "wss://relay.example.com" }],
      }),
    },
    { decide } as unknown as Decisions,
  );
  const tool = addTool.mock.calls[0]?.[0];
  if (!tool) throw new Error("decide was not added");
  const call = async (args: Record<string, unknown>, key = AGENT) =>
    String(await tool.call({ key } as BuzzClient, {}, args));
  return { tool, decide, call };
}

it("asks in System One's format as the agent's community, and answers in it", async () => {
  const { tool, decide, call } = setup((request) => {
    // What the tool sends meets the limits every provider accepts.
    expect(checkRequest(request)).toBeUndefined();
    return {
      outcome: "answered",
      backend: "buzz.typesafe/typesafe",
      model: "jev-1.13.0",
      answers: {
        billing: { type: "yes_no", probability: 0.9 },
        tone: {
          type: "choice",
          choice: "calm",
          confidence: 0.7,
          probabilities: { angry: 0.2, calm: 0.8 },
        },
        urgency: {
          type: "score",
          score: 1.7,
          confidence: 0.55,
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
        },
      },
    };
  });
  expect(tool.name).toBe("decide");
  const reply = await call({
    state: { message: "I was charged twice." },
    questions: {
      billing: {
        type: "noul",
        instructions: "Is this about billing?",
        criteria: { true: "Money or charges", false: "Anything else" },
      },
      tone: {
        type: "choice",
        instructions: { task: "Pick the tone." },
        criteria: { angry: "Upset", calm: null },
      },
      urgency: {
        type: "score",
        instructions: "How urgent?",
        criteria: ["Can wait", "This week", "Today"],
      },
    },
  });
  expect(decide).toHaveBeenCalledWith({
    state: '{"message":"I was charged twice."}',
    community: "wss://relay.example.com",
    questions: {
      billing: {
        type: "yes_no",
        instructions:
          "Is this about billing?\nYes means: Money or charges\nNo means: Anything else",
      },
      tone: {
        type: "choice",
        instructions: '{"task":"Pick the tone."}',
        options: { angry: "Upset", calm: "" },
      },
      urgency: {
        type: "score",
        instructions: "How urgent?",
        levels: ["Can wait", "This week", "Today"],
      },
    },
  });
  expect(JSON.parse(reply)).toEqual({
    model: "jev-1.13.0",
    provider: "buzz.typesafe/typesafe",
    answers: {
      billing: { type: "noul", noul: 0.9 },
      tone: {
        type: "choice",
        choice: "calm",
        confidence: 0.7,
        probabilities: { angry: 0.2, calm: 0.8 },
      },
      urgency: {
        type: "score",
        score: 1.7,
        confidence: 0.55,
        probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
        legend: { "0": "Can wait", "1": "This week", "2": "Today" },
      },
    },
  });
});

it("sends no community for an agent that does not run here", async () => {
  const { decide, call } = setup(() => ({
    outcome: "answered",
    backend: "buzz.typesafe/typesafe",
    model: "jev-1.13.0",
    answers: { spam: { type: "yes_no", probability: 0.1 } },
  }));
  await call(
    {
      state: "hi",
      questions: { spam: { type: "noul", instructions: "Spam?" } },
    },
    "b".repeat(64),
  );
  expect(decide.mock.calls[0]?.[0]).not.toHaveProperty("community");
});

it("tells the agent why a decision failed and what fixes it", async () => {
  const { call } = setup(() => ({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  }));
  await expect(
    call({
      state: "hi",
      questions: { spam: { type: "noul", instructions: "Spam?" } },
    }),
  ).rejects.toThrow(/Settings > Decisions API.*\(unavailable\)/);
});

it("refuses questions it cannot map before asking", async () => {
  const { decide, call } = setup(() => {
    throw new Error("not asked");
  });
  await expect(
    call({
      state: "photo",
      questions: { where: { type: "box", instructions: "Find it." } },
    }),
  ).rejects.toThrow("type must be noul, choice or score");
  await expect(
    call({
      state: "hi",
      questions: {
        tone: { type: "choice", instructions: "Tone?", criteria: ["a", "b"] },
      },
    }),
  ).rejects.toThrow("criteria maps each choice");
  await expect(
    call({
      state: "hi",
      questions: { level: { type: "score", instructions: "Level?" } },
    }),
  ).rejects.toThrow("criteria lists its levels");
  await expect(call({ state: "hi", questions: [] })).rejects.toThrow(
    "questions must map",
  );
  expect(decide).not.toHaveBeenCalled();
});

it("lists a schema every harness's model provider accepts", () => {
  const { tool } = setup(() => {
    throw new Error("not asked");
  });
  // Some model APIs refuse an array schema without `items`.
  const arrays: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ((node as { type?: unknown }).type === "array") arrays.push(node);
    for (const child of Object.values(node)) walk(child);
  };
  walk(tool.inputSchema);
  expect(arrays.length).toBeGreaterThan(0);
  for (const array of arrays) expect(array).toHaveProperty("items");
});
