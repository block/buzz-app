import type { Baseline } from "./baseline";
export function baselineFixture(owner: string, channel: string): Baseline {
  return {
    version: 1,
    owner,
    channel,
    revision: 3,
    recipes: {
      "small-task": { status: "available", evidence: [] },
      "remember-world": {
        status: "completed",
        evidence: [{ event: "a".repeat(64), quote: "Alex is my brother" }],
      },
      "check-in": { status: "available", evidence: [] },
    },
    cadences: {
      onboarding: { enabled: false, interval: 86400, nextDue: 1800000000 },
      commitments: { enabled: false, interval: 3600, nextDue: 1800000000 },
      dream: { enabled: true, interval: 86400, nextDue: 1800000000 },
    },
    memory: {
      people: {
        alex: {
          title: "Alex",
          links: [],
          revisions: [
            {
              text: "Alex is my brother",
              source: { event: "a".repeat(64), quote: "Alex is my brother" },
              at: 1790000000,
            },
          ],
        },
      },
      groups: {
        thursday: {
          title: "Thursday walkers",
          links: ["people/alex"],
          revisions: [
            {
              text: "Alex and I walk on Thursdays",
              source: {
                event: "b".repeat(64),
                quote: "Alex and I walk on Thursdays",
              },
              at: 1790000001,
            },
          ],
        },
      },
      relationships: {},
      facts: {},
      commitments: {},
    },
    dreams: [
      {
        at: 1790000002,
        summary:
          "The walking group may be a useful context for future plans. This is a question to explore, not a new fact.",
        sources: [
          { event: "b".repeat(64), quote: "Alex and I walk on Thursdays" },
        ],
        status: "reflection-not-fact",
      },
    ],
    notes: [],
    runs: [
      {
        at: 1790000002,
        purpose: "dream",
        summary: "Saved one cited reflection",
        trigger: "c".repeat(64),
      },
    ],
  };
}
