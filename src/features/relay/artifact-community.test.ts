import { describe, expect, it } from "vitest";
import {
  artifactTypeName,
  communityScope,
  parseTypePolicy,
  typePolicyFilter,
  typePolicyTemplate,
  validTypePolicy,
} from "./artifact-community";

const C = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const T = "com.example.groups.group";
const ID = "a".repeat(64);
// NIP-AR kind 9034: empty content, exactly these four tags.
const command = {
  kind: 9034,
  created_at: 1_700_000_000,
  content: "",
  tags: [
    ["community", C],
    ["type", T],
    ["policy", "admins"],
    ["prev", ID],
  ],
};

describe("communityScope", () => {
  const scope = (community_id: unknown, version: unknown = 1) => ({
    community_scope: { version, community_id, max_policies: 64 },
  });

  it("accepts version 1 with a canonical community only when nip-ar is listed", () => {
    expect(communityScope(scope(C), true)).toBe(C);
    expect(communityScope(scope(C), false)).toBeUndefined();
  });

  it.each([
    ["uppercase", scope(C.toUpperCase())],
    ["nil", scope("00000000-0000-0000-0000-000000000000")],
    ["version 2", scope(C, 2)],
    ["missing id", scope(undefined)],
    ["no community_scope", { sync: { version: 1 } }],
    ["no artifacts", undefined],
  ])("refuses %s", (_name, artifacts) => {
    expect(communityScope(artifacts, true)).toBeUndefined();
  });
});

describe("artifactTypeName", () => {
  it.each([
    [T, true],
    ["a.b", true],
    ["a1.b_c-d", true],
    [`a.${"b".repeat(126)}`, true],
    [`a.${"b".repeat(127)}`, false],
    ["nodot", false],
    ["Com.example", false],
    ["com.1example", false],
    ["com..example", false],
    [".com.example", false],
    ["com.example.", false],
  ])("%s is %s", (type, valid) => {
    expect(artifactTypeName(type)).toBe(valid);
  });
});

describe("type policy command", () => {
  it("builds exactly the four tags in order", () => {
    expect(typePolicyTemplate(C, T, "admins", ID, 1_700_000_000)).toEqual(
      command,
    );
    expect(() => validTypePolicy(command, C)).not.toThrow();
    const unset = {
      ...command,
      tags: [...command.tags.slice(0, 3), ["prev", "0"]],
    };
    expect(() => validTypePolicy(unset, C)).not.toThrow();
  });

  it("refuses a malformed type, policy or prev before signing", () => {
    expect(() => typePolicyTemplate(C, "Bad", "admins", "0", 1)).toThrow();
    expect(() =>
      typePolicyTemplate(C, T, "owners" as "admins", "0", 1),
    ).toThrow();
    expect(() => typePolicyTemplate(C, T, "admins", "1", 1)).toThrow();
  });

  const tags = command.tags;
  it.each([
    [
      "another community",
      { ...command },
      "11111111-1111-4111-8111-111111111111",
    ],
    ["no community at all", { ...command }, undefined],
    ["an extra tag", { ...command, tags: [...tags, ["h", C]] }, C],
    [
      "an h tag instead of community",
      { ...command, tags: [["h", C], ...tags.slice(1)] },
      C,
    ],
    ["non-empty content", { ...command, content: "{}" }, C],
    ["another kind", { ...command, kind: 45010 }, C],
    [
      "the wrong order",
      { ...command, tags: [tags[1], tags[0], tags[2], tags[3]] },
      C,
    ],
    [
      "uppercase prev",
      { ...command, tags: [...tags.slice(0, 3), ["prev", ID.toUpperCase()]] },
      C,
    ],
    [
      "a three-element tag",
      { ...command, tags: [...tags.slice(0, 3), ["prev", ID, "x"]] },
      C,
    ],
    [
      "a non-string prev",
      { ...command, tags: [...tags.slice(0, 3), ["prev", [ID]]] },
      C,
    ],
    ["an unsafe created_at", { ...command, created_at: 2 ** 53 }, C],
  ])("refuses %s", (_name, event, community) => {
    expect(() =>
      validTypePolicy(event as typeof command, community as string),
    ).toThrow("Invalid artifact type policy command");
  });
});

describe("type policy read", () => {
  it("is exactly the relay's policy filter", () => {
    expect(typePolicyFilter(T)).toEqual({
      artifact: "policy",
      scope: "community",
      "#type": [T],
    });
    expect(() => typePolicyFilter("nodot")).toThrow();
  });

  it("parses the relay's answer", () => {
    expect(parseTypePolicy({ policy: "everyone", revision: null })).toEqual({
      policy: "everyone",
      revision: null,
    });
    expect(parseTypePolicy({ policy: "admins", revision: ID })).toEqual({
      policy: "admins",
      revision: ID,
    });
  });

  it.each([
    [[{ policy: "everyone", revision: null }]],
    [{ policy: "owners", revision: null }],
    [{ policy: "admins" }],
    [{ policy: "admins", revision: "0" }],
    [{ policy: "admins", revision: ID.toUpperCase() }],
    [null],
  ])("refuses %j", (body) => {
    expect(() => parseTypePolicy(body)).toThrow("Invalid artifact type policy");
  });
});
