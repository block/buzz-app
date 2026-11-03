import { describe, expect, it } from "vitest";
import { getEventHash } from "nostr-tools";
import {
  completeTemplate,
  consentTemplate,
  fingerprint,
  importedMarker,
  importRecord,
  importRecordText,
  isImportedEvent,
  parseProposal,
  parseSnapshot,
  preparedProblem,
  proposalProblem,
  proposalTemplate,
  sourceLabel,
  withdrawTemplate,
  withoutImported,
} from "./protocol";
import type { ImportProposalInput } from "./types";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const relay = "c".repeat(64);
const channel = "f0".repeat(16);
const proposalId = "1".repeat(64);
const manifest = "d".repeat(64);
const now = 1_740_000_000;

const input: ImportProposalInput = {
  channelId: channel,
  source: {
    type: "slack",
    conversation: "e".repeat(64),
    kind: "dm",
    label: "Direct message",
  },
  range: { from: 1_735_689_600, to: 1_735_776_000 },
  participants: [
    { pubkey: bob, source_user: "2".repeat(64), messages: 3, reactions: 1 },
    { pubkey: alice, source_user: "3".repeat(64), messages: 2, reactions: 0 },
  ],
  excluded_authors: 1,
  manifest,
  expires_at: now + 86_400,
};
const { channelId: _channel, ...content } = input;

const signedFrom = (
  pubkey: string,
  template: { kind: number; content: string; tags: string[][] },
  created_at = now,
) => {
  const unsigned = { ...template, pubkey, created_at };
  return { ...unsigned, id: getEventHash(unsigned), sig: "0".repeat(128) };
};

const rules = {
  proposalId,
  channelId: channel,
  sourceType: "slack",
  range: input.range,
};
const message = (
  tags: string[][],
  extra: Partial<{ content: string }> = {},
) => ({
  kind: 9 as const,
  created_at: 1_735_732_800,
  tags,
  content: extra.content ?? "Hello",
});

describe("deterministic ids", () => {
  it("matches the NIP-CI test vector", () => {
    expect(
      getEventHash({
        pubkey: alice,
        created_at: 1_735_732_800,
        kind: 9,
        tags: [
          ["h", channel],
          ["import", proposalId],
          ["source", "slack", "1735732800.000100"],
        ],
        content: 'Hello "world"\nline two é 😀',
      }),
    ).toBe("8700e9d79a391c7bde29babf26fd2167e00335bafa08abfc8e21ea34b68268e4");
  });
});

describe("proposal", () => {
  it("emits NIP-CI key order and sorted participant tags", () => {
    const template = proposalTemplate(input);
    expect(template.kind).toBe(42110);
    expect(template.tags).toEqual([
      ["h", channel],
      ["p", alice],
      ["p", bob],
      ["manifest", manifest],
      ["import-source", "slack"],
    ]);
    expect(Object.keys(JSON.parse(template.content))).toEqual([
      "v",
      "source",
      "range",
      "participants",
      "excluded_authors",
      "manifest",
      "expires_at",
    ]);
    expect(
      JSON.parse(template.content).participants.map(
        (item: { pubkey: string }) => item.pubkey,
      ),
    ).toEqual([alice, bob]);
  });

  it("round-trips through the parser and rejects tags that disagree with content", () => {
    const event = signedFrom(alice, proposalTemplate(input));
    expect(parseProposal(event)?.content.participants).toHaveLength(2);
    const tampered = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === "manifest" ? ["manifest", "9".repeat(64)] : tag,
      ),
    };
    expect(parseProposal(tampered)).toBeUndefined();
  });

  it("enforces the proposal rules", () => {
    expect(proposalProblem(content, now)).toBeUndefined();
    expect(
      proposalProblem(
        { ...content, source: { ...content.source, type: "Slack!" } },
        now,
      ),
    ).toBeDefined();
    expect(
      proposalProblem({ ...content, range: { from: 10, to: 10 } }, now),
    ).toBeDefined();
    expect(
      proposalProblem({ ...content, range: { from: 10, to: now + 60 } }, now),
    ).toBeDefined();
    expect(
      proposalProblem({ ...content, participants: [] }, now),
    ).toBeDefined();
    expect(
      proposalProblem(
        {
          ...content,
          participants: [
            content.participants[0],
            content.participants[0],
          ] as never,
        },
        now,
      ),
    ).toBeDefined();
    expect(proposalProblem({ ...content, manifest: "xyz" }, now)).toBeDefined();
    expect(proposalProblem({ ...content, expires_at: now }, now)).toBeDefined();
    expect(
      proposalProblem({ ...content, excluded_authors: -1 }, now),
    ).toBeDefined();
  });
});

describe("records", () => {
  it("builds consent, withdraw and complete records in NIP-CI tag order", () => {
    const consent = consentTemplate(
      { id: proposalId, channelId: channel, manifest, proposer: alice },
      "accept",
      "2".repeat(64),
    );
    expect(consent.tags).toEqual([
      ["e", proposalId],
      ["h", channel],
      ["manifest", manifest],
      ["p", alice],
    ]);
    expect(consent.content).toBe(
      `{"v":1,"decision":"accept","source_user":"${"2".repeat(64)}"}`,
    );
    expect(withdrawTemplate(proposalId, channel).content).toBe('{"v":1}');
    expect(() =>
      withdrawTemplate(proposalId, channel, "x".repeat(201)),
    ).toThrow();
    expect(
      completeTemplate(proposalId, channel, { messages: 2, reactions: 0 })
        .content,
    ).toBe('{"v":1,"published":{"messages":2,"reactions":0}}');
  });

  it("describes each record as a system line", () => {
    const records = [
      signedFrom(alice, proposalTemplate(input)),
      signedFrom(
        bob,
        consentTemplate(
          { id: proposalId, channelId: channel, manifest, proposer: alice },
          "accept",
          "2".repeat(64),
        ),
      ),
      signedFrom(
        bob,
        consentTemplate(
          { id: proposalId, channelId: channel, manifest, proposer: alice },
          "accept",
          "admin",
        ),
      ),
      signedFrom(bob, withdrawTemplate(proposalId, channel, "Wrong range")),
      signedFrom(
        bob,
        completeTemplate(proposalId, channel, { messages: 1, reactions: 2 }),
      ),
    ].map((event) => {
      const record = importRecord(event);
      return record && importRecordText(record);
    });
    expect(records).toEqual([
      "Proposed importing Direct message from Slack",
      "Accepted the conversation import",
      "Approved the conversation import as an admin",
      "Withdrew the conversation import: Wrong range",
      "Finished importing 1 message and 2 reactions",
    ]);
  });

  it("accepts session snapshots only from the relay key", () => {
    const snapshot = {
      kind: 30623,
      content: JSON.stringify({
        v: 1,
        status: "active",
        required: [alice, bob],
        consents: { [alice]: "accept", [bob]: "accept" },
        published: { [alice]: { messages: 1, reactions: 0 } },
        completed: [],
        expires_at: now + 60,
      }),
      tags: [
        ["d", proposalId],
        ["e", proposalId],
        ["h", channel],
        ["p", alice],
        ["p", bob],
      ],
    };
    expect(parseSnapshot(signedFrom(relay, snapshot), relay)?.status).toBe(
      "active",
    );
    expect(parseSnapshot(signedFrom(alice, snapshot), relay)).toBeUndefined();
  });
});

describe("imported events", () => {
  it("validates the canonical kind 9 tag order", () => {
    const base = [
      ["h", channel],
      ["import", proposalId],
      ["source", "slack", "1735732800.000100"],
    ];
    expect(preparedProblem(message(base), rules, now)).toBeUndefined();
    expect(
      preparedProblem(
        message([
          ["h", channel],
          ["e", "4".repeat(64), "", "root"],
          ["e", "5".repeat(64), "", "reply"],
          ["p", alice],
          ["p", bob],
          ["import", proposalId],
          ["source", "slack", "1735732800.000200"],
          ["source-edited", "1"],
          ["source-flag", "broadcast"],
          ["imeta", "url https://media.example/abc.png", "m image/png"],
        ]),
        rules,
        now,
      ),
    ).toBeUndefined();
    expect(
      preparedProblem(
        message([
          ["h", channel],
          ["p", bob],
          ["p", alice],
          ["import", proposalId],
          ["source", "slack", "1"],
        ]),
        rules,
        now,
      ),
    ).toMatch("sorted");
    expect(
      preparedProblem(
        message([base[1], base[0], base[2]] as string[][]),
        rules,
        now,
      ),
    ).toMatch("destination channel");
    expect(
      preparedProblem(message([...base, ["client-id", "x"]]), rules, now),
    ).toMatch("Unexpected tag");
    expect(
      preparedProblem(
        message([base[0], ["import", "9".repeat(64)], base[2]] as string[][]),
        rules,
        now,
      ),
    ).toBeDefined();
    expect(
      preparedProblem(
        { ...message(base), created_at: input.range.to + 1 },
        rules,
        now,
      ),
    ).toMatch("range");
    expect(
      preparedProblem(message(base, { content: " " }), rules, now),
    ).toMatch("no content");
    expect(
      preparedProblem(
        { ...message(base), kind: 1 as unknown as 9 },
        rules,
        now,
      ),
    ).toMatch("kind 9");
  });

  it("validates the reaction tag order of the existing reaction builder", () => {
    const reaction = {
      kind: 7 as const,
      created_at: 1_735_732_801,
      content: "👍",
      tags: [
        ["h", channel],
        ["e", "4".repeat(64)],
        ["import", proposalId],
        ["source", "slack", "1735732800.000100"],
      ],
    };
    expect(preparedProblem(reaction, rules, now)).toBeUndefined();
    expect(
      preparedProblem(
        {
          ...reaction,
          tags: [
            reaction.tags[1],
            reaction.tags[0],
            ...reaction.tags.slice(2),
          ] as string[][],
        },
        rules,
        now,
      ),
    ).toBeDefined();
  });

  it("marks imported messages and keeps ordinary messages unmarked", () => {
    const tags = [
      ["h", channel],
      ["import", proposalId],
      ["source", "slack", "1735732800.000100"],
      ["source-edited", "1"],
    ];
    expect(isImportedEvent({ kind: 9, tags })).toBe(true);
    expect(isImportedEvent({ kind: 9, tags: [["h", channel]] })).toBe(false);
    expect(importedMarker({ kind: 9, tags })).toEqual({
      proposalId,
      source: "slack",
      ref: "1735732800.000100",
      sourceEdited: true,
    });
    expect(importedMarker({ kind: 9, tags: [["h", channel]] })).toBeUndefined();
  });

  it("drops imported history from a live batch before agents see it", () => {
    const imported = {
      kind: 7,
      tags: [
        ["h", channel],
        ["import", proposalId],
        ["source", "slack", "1"],
      ],
    };
    const live = { kind: 9, tags: [["h", channel]] };
    const batch = { epoch: 1, events: [imported, live] };
    expect(withoutImported(batch)).toEqual({ epoch: 1, events: [live] });
    const plain = { epoch: 2, events: [live] };
    expect(withoutImported(plain)).toBe(plain);
  });

  it("labels known and unknown sources", () => {
    expect(sourceLabel("slack")).toBe("Slack");
    expect(sourceLabel("team_chat")).toBe("Team Chat");
    expect(fingerprint("ab".repeat(32)).split(" ")).toHaveLength(8);
  });
});
