import { expect, it } from "vitest";
import { validChannelCommand } from "./session-commands.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const event = (body, tags = [["h", id]]) => ({
  kind: 9050,
  created_at: 1,
  content: JSON.stringify(body),
  tags,
});
it("rejects custom session commands", () => {
  expect(validChannelCommand(event({ action: "create", title: "Work" }))).toBe(
    false,
  );
  expect(
    validChannelCommand(
      event({ action: "move", parent_id: id, confirm_history: true }),
    ),
  ).toBe(false);
});
it("allows only ordinary invitations, without extra roles", () => {
  const invite = {
    kind: 9000,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["p", "a".repeat(64)],
    ],
  };
  expect(validChannelCommand(invite)).toBe(true);
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "admin"]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...invite, kind: 9001 })).toBe(false);
});

it("preserves strict Sessions metadata while allowing ordinary stream visibility", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  const child = (description) => ({
    ...create,
    tags: create.tags.map((tag) =>
      tag[0] === "about" ? ["about", description] : tag,
    ),
  });
  expect(
    validChannelCommand(child(`Buzz session (buzz.sessions/v1)\nparent:${id}`)),
  ).toBe(true);
  for (const parent of ["invalid", `${id}\nrole:owner`, `${id}extra`]) {
    expect(
      validChannelCommand(
        child(`Buzz session (buzz.sessions/v1)\nparent:${parent}`),
      ),
    ).toBe(false);
  }
  for (const [index, value] of [
    [3, "dm"],
    [1, " "],
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: create.tags.map((tag, i) =>
          i === index ? [tag[0], value] : tag,
        ),
      }),
    ).toBe(false);
  }
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag, i) =>
        i === 4 ? [tag[0], "Buzz session (forged)"] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["p", "a".repeat(64)]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...create, content: "extra" })).toBe(false);
});

it("accepts one trailing outbox identifier for invitations and rejects ambiguous envelopes", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    p = ["p", "a".repeat(64)],
    client = ["client-id", id];
  expect(validChannelCommand(invite([h, p, client]))).toBe(true);
  for (const tags of [
    [h, p, client, client],
    [client, h, p],
    [h, p, ["client-id", "invalid"]],
    [h, p, [...client, "extra"]],
  ])
    expect(validChannelCommand(invite(tags))).toBe(false);
});

it("allows bounded ordinary stream creation without a Sessions marker", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Updates for the team"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({ ...create, tags: create.tags.slice(0, 4) }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "x".repeat(1001)] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "Buzz session (forged)"] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["ttl", "604800"]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"]],
    }),
  ).toBe(true);
  for (const ttl of ["0", "-1", "forever", "2147483648"]) {
    expect(
      validChannelCommand({
        ...create,
        tags: [...create.tags, ["ttl", ttl]],
      }),
    ).toBe(false);
  }
});

it("does not add temporary cleanup to Sessions metadata", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
      ["ttl", "604800"],
    ],
  };
  expect(validChannelCommand(create)).toBe(false);
});
