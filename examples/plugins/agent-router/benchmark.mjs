// Print synthetic requests captured from the real plugin; performs no network
// calls and never reads a live agent's configuration. See BENCHMARK.md.
import { apply } from "./plugin.js";

const community = "https://relay.example.org";
const roles = [
  ["Assistant", "General assistant for weather, calendars and everyday tasks."],
  ["Budget", "Budget specialist. Use mcp_budget for campaign budget planning."],
  ["Writer", "Writer specializing in clear drafts, critique and editing."],
];
const candidates = roles.map(([name, instructions], i) => ({
  pubkey: String(i + 1).repeat(64),
  name,
  description: instructions,
}));
let router, captured;
apply({
  conversation: { registerAgentRouter: (value) => (router = value) },
  agents: {
    snapshot: () => ({
      agents: candidates.map((agent) => ({
        ...agent,
        relay: community,
        type: "example",
        config: { instructions: agent.description },
      })),
    }),
    types: () => [{ key: "example", carry: (config) => config }],
  },
  decisions: {
    decide: async (request) => {
      captured = request;
      return { outcome: "failed", reason: "unavailable" };
    },
  },
});
const scenarios = [
  ["weather", "What's the weather like today?"],
  ["calendar", "How does my calendar look tomorrow?"],
  ["budget", "Use mcp_budget to review my campaign budget."],
  [
    "independent",
    "Assistant, check tomorrow's calendar. Budget, review my campaign budget using mcp_budget. These are separate tasks.",
  ],
  ["opinions", "What are your thoughts on Buzz?"],
  [
    "collaboration",
    "Work together to draft a campaign plan, exchange intermediate drafts and review each other's work.",
  ],
];
const requests = [];
for (const [id, text] of scenarios) {
  await router.route({
    text,
    candidates,
    community,
    context: [],
    channelId: "benchmark",
  });
  requests.push({
    id,
    baselineStarts: candidates.length,
    decisionRequestBytes: Buffer.byteLength(JSON.stringify(captured)),
    state: JSON.parse(captured.state),
    // decisions_ask uses System One's criteria name for choice options.
    questions: Object.fromEntries(
      Object.entries(captured.questions).map(([key, question]) => [
        key,
        {
          type: question.type,
          instructions: question.instructions,
          criteria: question.options,
        },
      ]),
    ),
  });
}
process.stdout.write(`${JSON.stringify(requests, null, 2)}\n`);
