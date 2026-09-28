import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { pendingAgentRequest } from "./agent-request";
const row = (
  id: string,
  authorId: string,
  mentions: string[] = [],
  delivery?: ChannelMessage["delivery"],
) =>
  ({
    id,
    channelId: "c",
    threadRootId: "root",
    authorId,
    mentions,
    createdAt: 10,
    delivery,
    content: "Request",
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  }) satisfies ChannelMessage;
it("an older same-second reply never suppresses a subsequent request", () => {
  const request = row("request", "viewer", ["agent"]);
  const prior = row("prior", "agent");
  expect(
    pendingAgentRequest([prior, request], "viewer", new Set(["agent"]), "root"),
  ).toEqual({ message: request, agents: ["agent"] });
  expect(
    pendingAgentRequest([request, prior], "viewer", new Set(["agent"]), "root"),
  ).toBeUndefined();
});
it("keeps unsent/uncertain requests even with unrelated later same-agent messages", () => {
  for (const delivery of ["sending", "failed", "unknown"] as const) {
    const request = row("request", "viewer", ["agent"], delivery);
    expect(
      pendingAgentRequest(
        [request, row("reply", "agent")],
        "viewer",
        new Set(["agent"]),
        "root",
      )?.message.delivery,
    ).toBe(delivery);
  }
});
it("requires exact author/root, handles multiple agents and excludes humans", () => {
  const request = row("request", "viewer", ["a", "b", "a", "human"]);
  const response = row("response", "a");
  expect(
    pendingAgentRequest(
      [request, response],
      "viewer",
      new Set(["a", "b"]),
      "root",
    )?.agents,
  ).toEqual(["b"]);
  expect(
    pendingAgentRequest(
      [request, { ...response, threadRootId: "other" }],
      "viewer",
      new Set(["a", "b"]),
      "root",
    )?.agents,
  ).toEqual(["a", "b"]);
  expect(
    pendingAgentRequest([request], "other", new Set(["a", "b"]), "root"),
  ).toBeUndefined();
});

it("keeps only the coordination author's pending response, without changing uncertainty or other recipients", () => {
  for (const delivery of [undefined, "seen", "accepted"] as const) {
    const request = row("request", "viewer", ["a", "b"], delivery);
    const coordination = { ...row("coord", "a"), audience: "agents" as const };
    expect(
      pendingAgentRequest(
        [request, coordination, row("reply-b", "b")],
        "viewer",
        new Set(["a", "b"]),
        "root",
      )?.agents,
    ).toEqual(["a"]);
    expect(
      pendingAgentRequest(
        [
          request,
          coordination,
          row("reply-b", "b"),
          { ...row("reply-a", "a"), audience: "everyone" },
        ],
        "viewer",
        new Set(["a", "b"]),
        "root",
      ),
    ).toBeUndefined();
  }
});

it.each([2, 3, 7, 32])(
  "settles %s recipient identities independently of response order and coordination",
  (count) => {
    const agents = Array.from({ length: count }, (_, i) => `agent-${i}`);
    const request = row("request", "viewer", agents, "seen");
    const rows: ChannelMessage[] = [
      request,
      ...agents.map((key) => ({
        ...row(`coord-${key}`, key),
        audience: "agents" as const,
      })),
    ];
    expect(
      pendingAgentRequest(rows, "viewer", new Set(agents), "root")?.agents,
    ).toEqual(agents);
    for (const key of [...agents].reverse()) {
      rows.push({ ...row(`reply-${key}`, key), audience: "everyone" });
      const remaining = agents.slice(0, agents.indexOf(key));
      expect(
        pendingAgentRequest(rows, "viewer", new Set(agents), "root")?.agents ??
          [],
      ).toEqual(remaining);
    }
  },
);

it("documents the current latest-request-only limit instead of claiming overlapping-request tracking", () => {
  const first = row("earlier", "viewer", ["a", "b"], "seen");
  const latest = row("later", "viewer", ["a", "c"], "seen");
  expect(
    pendingAgentRequest(
      [first, latest],
      "viewer",
      new Set(["a", "b", "c"]),
      "root",
    ),
  ).toEqual({ message: latest, agents: ["a", "c"] });
});
