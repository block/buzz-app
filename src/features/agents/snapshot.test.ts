import { expect, it } from "vitest";
import { controlFixture } from "./control-testing";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  parseAgentSnapshot,
} from "./snapshot";
const utf8 = new TextEncoder();
const parse = (value: unknown) =>
  parseAgentSnapshot(utf8.encode(JSON.stringify(value)));

it.each(["json", "png"] as const)(
  "round trips %s with no credentials, identity, or local arguments",
  (format) => {
    const { agent } = controlFixture();
    agent.systemPrompt = "Handle café carefully.";
    agent.picture = "https://images.example.test/avatar.png";
    const snapshot = buildAgentSnapshot(agent);
    const bytes = encodeAgentSnapshot(snapshot, format);
    expect(parseAgentSnapshot(bytes)).toEqual(snapshot);
    const text = new TextDecoder().decode(
      format === "json" ? bytes : encodeAgentSnapshot(snapshot, "json"),
    );
    for (const secret of [
      agent.pubkey,
      agent.id,
      agent.workspace,
      "EXAMPLE_TOKEN",
      "--literal",
      "DO_NOT_PROJECT",
    ])
      expect(text).not.toContain(secret);
    expect(snapshot.memory).toEqual({ level: "none", entries: [] });
    expect(
      JSON.parse(
        new TextDecoder().decode(encodeAgentSnapshot(snapshot, "json")),
      ).memory,
    ).toEqual({ level: "none" });
  },
);

it.each(["core", "everything"] as const)(
  "round trips %s memory only after selection",
  (level) => {
    const source = [
      { slug: "core", body: "remember this" },
      { slug: "mem/one", body: "value" },
    ];
    const manifest = buildAgentSnapshot(controlFixture().agent, level, source);
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(manifest, "png")).memory.entries,
    ).toEqual(level === "core" ? source.slice(0, 1) : source);
  },
);

it.each(["none", "core", "everything"] as const)(
  "accepts a reference %s snapshot with omitted empty entries",
  (level) => {
    const manifest = buildAgentSnapshot(controlFixture().agent);
    const decoded = parse({ ...manifest, memory: { level } });
    expect(decoded.memory).toEqual({ level, entries: [] });
    expect(
      JSON.parse(new TextDecoder().decode(encodeAgentSnapshot(decoded, "json")))
        .memory,
    ).toEqual({ level });
  },
);

it("rejects source credentials, imported runtime knobs and inconsistent memory before preview", () => {
  const manifest = buildAgentSnapshot(controlFixture().agent);
  expect(() => parse({ ...manifest, privateKey: "nsec" })).toThrow(
    "Invalid snapshot manifest",
  );
  expect(() =>
    parse({
      ...manifest,
      definition: { ...manifest.definition, environment: { KEY: "secret" } },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      definition: { ...manifest.definition, acpCommand: "buzz-agent" },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      definition: { ...manifest.definition, respondTo: "anyone" },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: { level: "none", entries: [{ slug: "core", body: "x" }] },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: {
        level: "everything",
        entries: [{ slug: "mem/../oops", body: "x" }],
      },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: {
        level: "core",
        entries: [{ slug: "core", body: "é".repeat(40000) }],
      },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() => parse({ ...manifest, version: 2 })).toThrow(
    "Unsupported snapshot version",
  );
  const png = encodeAgentSnapshot(manifest, "png");
  png[20] = (png[20] ?? 0) ^ 1;
  expect(() => parseAgentSnapshot(png)).toThrow("Invalid PNG snapshot");
});
