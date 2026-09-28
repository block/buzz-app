import { expect, it } from "vitest";
import { messageAudience } from "./message-audience";
import { foldMessages } from "./fold";
import { shareMessageRows } from "./row-identity";
import { pendingAgentRequest } from "../messages/agent-request";
import { keypair, message, signed } from "./testing";

it("matches Brad's exact declaration matrix without inferring author or recipients", () => {
  for (const kind of [9, 45001, 45003]) {
    for (const value of ["agents", "everyone"])
      expect(
        messageAudience(kind, [
          ["p", "human"],
          ["audience", value],
        ]),
      ).toBe(value);
    for (const tags of [
      undefined,
      null,
      {},
      [],
      [["audience"]],
      [["audience", "Agents"]],
      [["audience", "future"]],
      [["audience", null]],
      [["audience", "agents", "extra"]],
      [
        ["audience", "agents"],
        ["audience", "agents"],
      ],
      [
        ["audience", "agents"],
        ["audience", "everyone"],
      ],
    ])
      expect(messageAudience(kind, tags)).toBeUndefined();
  }
  for (const kind of [7, 40002, 40003, 40008, 24200, "9", undefined])
    expect(messageAudience(kind, [["audience", "agents"]])).toBeUndefined();
});

it("folds original signed intent through edits and preserves pending human responses through coordination", () => {
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const root = message(viewer, "one", "Please investigate", 1, [
    ["p", agent.pubkey],
  ]);
  const coordination = message(agent, "one", "@Peer check this", 2, [
    ["e", root.id, "", "reply"],
    ["audience", "agents"],
  ]);
  const edit = signed(agent, {
    kind: 40003,
    created_at: 3,
    tags: [
      ["h", "one"],
      ["e", coordination.id],
      ["audience", "everyone"],
    ],
    content: "Updated coordination",
  });
  const rows = foldMessages("one", relay.pubkey, [root, coordination, edit], {
    includeReplies: true,
  });
  expect(rows[1]).toMatchObject({
    id: coordination.id,
    content: "Updated coordination",
    audience: "agents",
    edited: true,
  });
  expect(
    pendingAgentRequest(rows, viewer.pubkey, new Set([agent.pubkey]), root.id)
      ?.agents,
  ).toEqual([agent.pubkey]);
  for (const tags of [
    [],
    [["audience", "everyone"]],
    [["audience", "agents", "extra"]],
    [
      ["audience", "agents"],
      ["audience", "everyone"],
    ],
  ]) {
    const reply = message(agent, "one", "Human-facing answer", 4, [
      ["e", root.id, "", "reply"],
      ...tags,
    ]);
    const folded = foldMessages(
      "one",
      relay.pubkey,
      [root, coordination, edit, reply],
      { includeReplies: true },
    );
    expect(
      pendingAgentRequest(
        folded,
        viewer.pubkey,
        new Set([agent.pubkey]),
        root.id,
      ),
    ).toBeUndefined();
    expect(folded.map((row) => row.id)).toContain(coordination.id); // Never hide the message.
  }
  const humanCoordination = message(
    viewer,
    "one",
    "Self-declared audience is not an agent badge",
    5,
    [["audience", "agents"]],
  );
  expect(
    foldMessages("one", relay.pubkey, [humanCoordination])[0]?.audience,
  ).toBe("agents");
});

it("cannot attach audience through an edit and never reuses a row with changed audience", () => {
  const author = keypair(),
    relay = keypair();
  const root = message(author, "one", "Legacy message", 1);
  const edit = signed(author, {
    kind: 40003,
    created_at: 2,
    content: "Edited",
    tags: [
      ["h", "one"],
      ["e", root.id],
      ["audience", "agents"],
    ],
  });
  const rows = foldMessages("one", relay.pubkey, [root, edit]);
  const row = rows[0];
  if (!row) throw new Error("No folded row");
  expect(row.audience).toBeUndefined();
  const agents = { ...row, audience: "agents" as const };
  const everyone = { ...row, audience: "everyone" as const };
  expect(shareMessageRows(rows, [agents])[0]).toBe(agents);
  expect(shareMessageRows([agents], [everyone])[0]).toBe(everyone);
  expect(shareMessageRows([agents], [row])[0]).toBe(row);
  expect(shareMessageRows([agents], [{ ...agents }])[0]).toBe(agents);
});
