import { expect, it } from "vitest";
import { controlFixture } from "./control-testing";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  parseAgentSnapshot,
} from "./snapshot";
const portableAgent = () => {
  const { agent } = controlFixture();
  agent.harness.command = "buzz-agent";
  agent.sessionPolicy = "thread";
  agent.harness.environmentKeys = [];
  return agent;
};
const utf8 = new TextEncoder();
const parse = (value: unknown) =>
  parseAgentSnapshot(utf8.encode(JSON.stringify(value)));

it("exports the native listener fallback explicitly across different destination defaults", () => {
  const source = portableAgent();
  source.launchParallelism = 1; // Native projection when no worker setting exists.
  const exported = buildAgentSnapshot(source);
  expect(exported.definition.parallelism).toBe(1);
  const imported = parseAgentSnapshot(encodeAgentSnapshot(exported, "json"));
  expect(imported.definition.parallelism).toBe(1);
  // Import writes 1 rather than inheriting the destination's worker default of 4.
  const destination = portableAgent();
  destination.launchParallelism = imported.definition.parallelism ?? null;
  expect(buildAgentSnapshot(destination).definition.parallelism).toBe(1);
  expect(
    parseAgentSnapshot(encodeAgentSnapshot(exported, "png")).definition
      .parallelism,
  ).toBe(1);
});

it.each(["json", "png"] as const)(
  "round trips %s with no credentials, identity, or local arguments",
  (format) => {
    const { agent } = controlFixture();
    Object.assign(agent.harness, { command: "buzz-agent" });
    agent.sessionPolicy = "thread";
    agent.harness.environmentKeys = [];
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
    const manifest = buildAgentSnapshot(portableAgent(), level, source);
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(manifest, "png")).memory.entries,
    ).toEqual(level === "core" ? source.slice(0, 1) : source);
  },
);

it.each(["none", "core", "everything"] as const)(
  "accepts a reference %s snapshot with omitted empty entries",
  (level) => {
    const manifest = buildAgentSnapshot(portableAgent());
    const decoded = parse({ ...manifest, memory: { level } });
    expect(decoded.memory).toEqual({ level, entries: [] });
    expect(
      JSON.parse(new TextDecoder().decode(encodeAgentSnapshot(decoded, "json")))
        .memory,
    ).toEqual({ level });
  },
);

it("rejects source credentials and inconsistent memory before preview", () => {
  const manifest = buildAgentSnapshot(portableAgent());
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
  expect(
    parse({
      ...manifest,
      definition: { ...manifest.definition, respondTo: "anyone" },
    }).definition.respondTo,
  ).toBe("anyone");
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

it.each(["json", "png"] as const)(
  "accepts reference-serde v1 field casing and parallelism in %s",
  (format) => {
    // Reference AgentSnapshotDefinition derives serde camelCase; source_is_builtin
    // serializes as sourceIsBuiltin and parallelism is always emitted by build_snapshot.
    const reference = {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name: "Reference",
        sourceIsBuiltin: false,
        systemPrompt: "Review changes.",
        parallelism: 1,
      },
      profile: { displayName: "Reference" },
      memory: { level: "none" },
    };
    const manifest = parse(reference);
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(manifest, format)).definition,
    ).toMatchObject(reference.definition);
    expect(manifest.definition.sessionPolicy).toBeUndefined(); // reference omission means channel
  },
);

it.each([1, 4])(
  "round trips reference parallelism %i through projected native saved settings",
  (workers) => {
    const reference = buildAgentSnapshot(portableAgent());
    reference.definition.parallelism = workers;
    // AgentEdit.environment persists the imported count. The native snapshot
    // exposes its effective numeric count, not its write-only environment value.
    const native = portableAgent();
    native.harness.environmentKeys = ["BUZZ_ACP_AGENTS"];
    native.launchParallelism = workers;
    for (const format of ["json", "png"] as const) {
      const first = parseAgentSnapshot(encodeAgentSnapshot(reference, format));
      expect(first.definition.parallelism).toBe(workers);
      const exported = buildAgentSnapshot(native);
      const second = parseAgentSnapshot(encodeAgentSnapshot(exported, format));
      expect(second.definition.parallelism).toBe(first.definition.parallelism);
      expect(second.definition.model).toBe(first.definition.model);
      expect(second.definition.provider).toBe(first.definition.provider);
    }
    native.harness.environmentKeys.push("PRIVATE_SETTING");
    expect(() => buildAgentSnapshot(native)).toThrow(
      /cannot be exported faithfully/,
    );
  },
);

it("uses effective nonsecret selectors rather than saved inherited blanks", () => {
  const agent = portableAgent();
  agent.harness.model = "";
  agent.harness.provider = "";
  agent.launchModel = "source-model";
  agent.launchProvider = "source-provider";
  expect(buildAgentSnapshot(agent).definition).toMatchObject({
    model: "source-model",
    provider: "source-provider",
  });
  agent.launchModelEnv = "BUZZ_AGENT_MODEL";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
});

it("blocks credential-like allowed values and unsupported source behavior at export", () => {
  const agent = portableAgent();
  agent.systemPrompt = "Use api_key=INERT_SENTINEL_12345678";
  expect(() => buildAgentSnapshot(agent)).toThrow(/credential/);
  agent.systemPrompt = "Review changes.";
  agent.respondTo = "anyone";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
  agent.respondTo = "owner-only";
  agent.harness.command = "goose";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
});

it("resolves inherited source session policy and rejects invisible prompt controls", () => {
  const inherited = portableAgent();
  inherited.sessionPolicy = null;
  expect(
    buildAgentSnapshot(inherited, "none", [], "channel").definition
      .sessionPolicy,
  ).toBe("channel");
  expect(() => buildAgentSnapshot(inherited)).toThrow(
    /cannot be exported faithfully/,
  );
  const manifest = buildAgentSnapshot(portableAgent());
  for (const character of ["\u202e", "\u200b", "\u{e0061}"]) {
    expect(() =>
      parse({
        ...manifest,
        definition: {
          ...manifest.definition,
          systemPrompt: `Review${character} this.`,
        },
      }),
    ).toThrow(/Invalid snapshot manifest/);
  }
  expect(
    parse({
      ...manifest,
      definition: { ...manifest.definition, systemPrompt: "Review 👩‍💻 ❤️" },
    }).definition.systemPrompt,
  ).toBe("Review 👩‍💻 ❤️");
});

it("uses supplied PNG artwork as pixels and never copies its snapshot metadata", () => {
  const manifest = buildAgentSnapshot(portableAgent());
  const artwork = encodeAgentSnapshot(manifest, "png");
  const image = encodeAgentSnapshot(
    { ...manifest, profile: { displayName: "Another" } },
    "png",
    artwork,
  );
  expect(parseAgentSnapshot(image).profile.displayName).toBe("Another");
  const text = new TextDecoder().decode(image);
  expect(text.match(/buzz_agent_snapshot/g)).toHaveLength(1);
});
