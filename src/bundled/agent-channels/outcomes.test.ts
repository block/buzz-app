import { expect, it } from "vitest";
import type { Objects } from "../../features/objects/service";
import type { VisibleEvent } from "../../features/relay/projection";
import { extractAgentOutcomes } from "./outcomes";

const objects = {
  resolve(target: string) {
    const match =
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(target);
    return match
      ? {
          provider: { key: "github" },
          reference: {
            provider: "github",
            key: `${match[1]}:pull:#${match[2]}`,
            kind: "pull",
            url: target,
            label: `#${match[2]}`,
            group: match[1],
          },
        }
      : undefined;
  },
} as unknown as Pick<Objects, "resolve">;
const event = (
  id: string,
  pubkey: string,
  channel: string,
  content: string,
  created_at: number,
): VisibleEvent => ({
  id: id.padEnd(64, "0"),
  pubkey,
  kind: 9,
  content,
  created_at,
  tags: [["h", channel]],
});
const agents = [
  { id: "rizz", name: "Rizz", identityPubkeys: ["r"] },
  { id: "fizz", name: "Fizz", identityPubkeys: ["f"] },
];
const channels = [
  { id: "map", name: "Map", archived: false },
  { id: "other", name: "Other", archived: false },
];

it("deduplicates directly agent-shared pull requests while preserving signed evidence", () => {
  const outcomes = extractAgentOutcomes(
    [
      event(
        "a",
        "r",
        "map",
        "Shipped https://github.com/block/buzz/pull/8",
        20,
      ),
      event(
        "b",
        "f",
        "other",
        "Review (https://github.com/block/buzz/pull/8).",
        30,
      ),
      event(
        "c",
        "r",
        "map",
        "Issue https://github.com/block/buzz/issues/8",
        40,
      ),
      event("d", "human", "map", "https://github.com/block/buzz/pull/9", 50),
    ],
    agents,
    channels,
    objects,
  );
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    reference: { label: "#8", group: "block/buzz" },
    evidence: [
      { agentId: "fizz", channelId: "other", sharedAt: 30 },
      { agentId: "rizz", channelId: "map", sharedAt: 20 },
    ],
  });
});

it("ignores failed and unauthorized-channel evidence", () => {
  expect(
    extractAgentOutcomes(
      [
        {
          ...event("a", "r", "map", "https://github.com/block/buzz/pull/1", 1),
          delivery: "failed",
        },
        event("b", "r", "hidden", "https://github.com/block/buzz/pull/2", 2),
      ],
      agents,
      channels,
      objects,
    ),
  ).toEqual([]);
});
