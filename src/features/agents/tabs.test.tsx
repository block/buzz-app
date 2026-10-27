// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Agent, Agents } from "./service";
import { agentSections } from "./tabs";

afterEach(cleanup);

const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/triage": {
      slug: "interest/triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Triage." },
    },
    "watch/asks": {
      slug: "watch/asks",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
        classifier: {
          questions: { asks: { question: "Is this a question?" } },
        },
      },
    },
  },
} as Agent;

it("keeps only the device runtime control on the agent detail tab", () => {
  const agents = { save: async () => {} } as unknown as Agents;
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
    memories: undefined,
  }).find((tab) => tab.value === "agent:attention");
  render(<div>{section?.render()}</div>);
  expect(
    screen.getByRole("switch", { name: "Attention on this device" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Triage.")).not.toBeInTheDocument();
});
