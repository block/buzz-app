import { describe, expect, it } from "vitest";
import { publicAgentMetadata } from "./public-metadata";
import { keypair, signed } from "../relay/testing";
const agent = keypair(),
  owner = keypair(),
  stranger = keypair();
const legacy = (content: unknown, created_at = 1) =>
  signed(agent, {
    kind: 10100,
    content: JSON.stringify(content),
    created_at,
    tags: [],
  });
const policy = (
  content: unknown,
  created_at = 2,
  author = owner,
  key = agent.pubkey,
) =>
  signed(author, {
    kind: 30177,
    content: JSON.stringify(content),
    created_at,
    tags: [["d", key]],
  });
const validPolicy = { name: "Agent", parallelism: 4, respond_to: "owner-only" };
const runtime = legacy({
  agent_type: "goose",
  capabilities: ["code", "search"],
});
describe("public agent metadata", () => {
  it("uses exact event authors, never body pubkeys or unrelated kinds", () => {
    expect(publicAgentMetadata([], agent.pubkey)).toBeUndefined();
    expect(publicAgentMetadata([runtime], stranger.pubkey)).toBeUndefined();
    expect(
      publicAgentMetadata(
        [
          legacy({
            pubkey: stranger.pubkey,
            agent_type: "codex-acp",
            capabilities: ["code"],
          }),
        ],
        agent.pubkey,
      ),
    ).toEqual({ agentType: "codex-acp", capabilities: ["code"] });
  });
  it.each([null, [], 42, {}, { agent_type: false, capabilities: "code" }])(
    "defaults sparse/malformed legacy fields like base: %j",
    (body) => {
      expect(publicAgentMetadata([legacy(body)], agent.pubkey)).toEqual({
        agentType: "agent",
        capabilities: [],
      });
    },
  );
  it("rejects mixed arrays without reviving older capabilities", () => {
    expect(
      publicAgentMetadata(
        [runtime, legacy({ capabilities: ["code", 1] }, 2)],
        agent.pubkey,
      ),
    ).toBeUndefined();
    expect(publicAgentMetadata([runtime, legacy({}, 2)], agent.pubkey)).toEqual(
      { agentType: "agent", capabilities: [] },
    );
  });
  it("selects latest by timestamp and lowest id on ties, regardless of arrival order", () => {
    const other = legacy({ agent_type: "aider", capabilities: [] });
    const winner = runtime.id < other.id ? runtime : other;
    for (const events of [
      [runtime, other],
      [other, runtime],
    ])
      expect(publicAgentMetadata(events, agent.pubkey)).toEqual(
        publicAgentMetadata([winner], agent.pubkey),
      );
  });
  it("requires a verified owner for the exact policy coordinate and overlays legacy fields", () => {
    const managed = policy(validPolicy);
    expect(publicAgentMetadata([runtime, managed], agent.pubkey)).toEqual({
      agentType: "goose",
      capabilities: ["code", "search"],
    });
    expect(
      publicAgentMetadata([runtime, managed], agent.pubkey, owner.pubkey),
    ).toEqual({ agentType: "agent", capabilities: [] });
    for (const forged of [
      policy(validPolicy, 3, stranger),
      policy(validPolicy, 3, owner, stranger.pubkey),
    ])
      expect(
        publicAgentMetadata([runtime, forged], agent.pubkey, owner.pubkey),
      ).toEqual({ agentType: "goose", capabilities: ["code", "search"] });
  });
  it.each([
    null,
    {},
    { ...validPolicy, parallelism: -1 },
    { ...validPolicy, parallelism: 2 ** 32 },
    { ...validPolicy, respond_to: "everyone" },
    { ...validPolicy, respond_to_allowlist: [2] },
    { ...validPolicy, model: {} },
  ])(
    "reserves a malformed newest policy instead of resurrecting legacy: %j",
    (body) => {
      expect(
        publicAgentMetadata(
          [runtime, policy(validPolicy), policy(body, 3)],
          agent.pubkey,
          owner.pubkey,
        ),
      ).toBeUndefined();
    },
  );
  it("does not promote pending local publication to public evidence", () => {
    expect(
      publicAgentMetadata([{ ...runtime, delivery: "failed" }], agent.pubkey),
    ).toBeUndefined();
    expect(
      publicAgentMetadata([{ ...runtime, delivery: "sending" }], agent.pubkey),
    ).toBeUndefined();
  });
});
