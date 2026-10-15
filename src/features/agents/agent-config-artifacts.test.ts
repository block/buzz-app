import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { PublishRejected } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactProblem,
  artifactTemplate,
  deliver,
  refusal,
  settle,
  signedSize,
  uuidv5,
  type Read,
} from "./agent-config-artifacts";

const key = generateSecretKey();
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const sign = (t: ReturnType<typeof artifactTemplate>) =>
  finalizeEvent(t, key) as RelayEvent;
async function instructions(text: string, prev?: string) {
  const d = await artifactD("buzz.agent.instructions", channel);
  const expected = { channel, type: "buzz.agent.instructions" as const, d };
  const event = sign(
    artifactTemplate({
      ...expected,
      ...(prev ? { op: "update" as const, prev } : { op: "create" as const }),
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text }),
    }),
  );
  return { expected, event };
}
const writer = (publish: () => Promise<void>) => ({
  sign: async () => {
    throw new Error("unused");
  },
  publish,
});

describe("artifact identity", () => {
  it("derives RFC 4122 UUIDv5 values", async () => {
    // RFC 4122 appendix: "www.example.com" in the DNS namespace.
    expect(
      await uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("gives each type one stable d per channel", async () => {
    const a = await artifactD("buzz.agent.settings", channel);
    expect(await artifactD("buzz.agent.settings", channel)).toBe(a);
    expect(await artifactD("buzz.agent.instructions", channel)).not.toBe(a);
  });
});

describe("artifact validation", () => {
  it("accepts a valid revision, including empty instructions", async () => {
    const { expected, event } = await instructions("");
    expect(artifactProblem(event, expected)).toBeUndefined();
  });

  it("rejects a revision from another channel, type or identity", async () => {
    const { expected, event } = await instructions("hi");
    expect(artifactProblem(event, { ...expected, channel: "x" })).toMatch(
      /home/,
    );
    expect(
      artifactProblem(event, { ...expected, type: "buzz.agent.settings" }),
    ).toMatch(/type/);
    expect(artifactProblem(event, { ...expected, d: "x" })).toMatch(/identity/);
  });

  it("rejects unknown versions, U+0000 and oversize content", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const expected = { channel, type: "buzz.agent.instructions" as const, d };
    const make = (content: string) =>
      sign(
        artifactTemplate({ ...expected, op: "create", title: "t", content }),
      );
    expect(artifactProblem(make('{"version":2,"text":""}'), expected)).toMatch(
      /version/,
    );
    expect(
      artifactProblem(make('{"version":1,"text":"a\\u0000"}'), expected),
    ).toBeUndefined();
    expect(
      artifactProblem(make(`{"version":1,"text":"\u0000"}`), expected),
    ).toMatch(/U\+0000/);
    const big = JSON.stringify({
      version: 1,
      text: "x".repeat(ARTIFACT_MAX_CONTENT_BYTES),
    });
    expect(artifactProblem(make(big), expected)).toMatch(/too large/);
  });

  it("requires the team name to match its title and one team tag", async () => {
    const d = await artifactD("buzz.team", channel);
    const expected = { channel, type: "buzz.team" as const, d };
    const team = (title: string, extra: string[][]) =>
      sign(
        artifactTemplate({
          ...expected,
          op: "create",
          title,
          content: JSON.stringify({
            version: 1,
            name: "Core",
            instructions: "",
          }),
          extra,
        }),
      );
    expect(
      artifactProblem(team("Core", [["team", "t1"]]), expected),
    ).toBeUndefined();
    expect(artifactProblem(team("Other", [["team", "t1"]]), expected)).toMatch(
      /team/,
    );
    expect(artifactProblem(team("Core", []), expected)).toMatch(/team/);
  });

  it("measures a maximum-size revision inside the signing bound", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const template = artifactTemplate({
      channel,
      type: "buzz.agent.instructions",
      d,
      op: "update",
      prev: "f".repeat(64),
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text: '"'.repeat(65_530) }),
    });
    const size = signedSize(getPublicKey(key), template);
    expect(size).toBeGreaterThan(64 * 1024);
    expect(size).toBeLessThanOrEqual(ARTIFACT_MAX_EVENT_BYTES);
  });
});

describe("delivery", () => {
  it("classifies refusals by their prefix, not the HTTP status", () => {
    expect(refusal("conflict: prev is not current")).toBe("conflict");
    expect(refusal("duplicate: already have this event")).toBe("duplicate");
    expect(refusal("restricted: not a member")).toBe("permission");
    expect(refusal("restricted: channel is archived")).toBe("archived");
    expect(refusal("invalid: event too large")).toBe("too-large");
    expect(refusal("invalid: bad envelope")).toBe("invalid");
    expect(refusal("rate-limited: slow down")).toBe("rate-limited");
    expect(refusal("Relay rejected the message (400)")).toBe("unknown");
  });

  it("counts only OK or duplicate-OK as accepted, and never settles a lost answer as refused", async () => {
    const { event } = await instructions("hi");
    const signal = new AbortController().signal;
    expect(
      (
        await deliver(
          writer(async () => {}),
          event,
          signal,
        )
      ).status,
    ).toBe("accepted");
    const dup = writer(async () => {
      throw new PublishRejected("duplicate: already accepted");
    });
    expect((await deliver(dup, event, signal)).status).toBe("accepted");
    const lost = writer(async () => {
      throw new Error("socket closed");
    });
    expect((await deliver(lost, event, signal)).status).toBe("uncertain");
    const untyped = writer(async () => {
      throw new PublishRejected("Relay rejected the message (400)");
    });
    expect((await deliver(untyped, event, signal)).status).toBe("uncertain");
    const conflict = await deliver(
      writer(async () => {
        throw new PublishRejected("conflict: prev is not current");
      }),
      event,
      signal,
    );
    expect(conflict).toMatchObject({ status: "refused", refusal: "conflict" });
  });

  it("never installs an accepted replay that is not the head", async () => {
    const { event: older } = await instructions("old");
    const { event: newer } = await instructions("new", older.id);
    const reads =
      (head?: RelayEvent): Read =>
      async () =>
        head ? [head] : [];
    expect(await settle(reads(older), older)).toMatchObject({
      status: "current",
    });
    expect(await settle(reads(newer), older)).toMatchObject({
      status: "superseded",
      head: newer,
    });
    expect(await settle(reads(), older)).toEqual({
      status: "accepted-unavailable",
    });
  });
});
