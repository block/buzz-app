import { reviewAgentProfile, reviewTestAccess } from "./testing";
import { expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import type { EventTemplate } from "nostr-tools";
import { keypair, signed } from "../../features/relay/testing";
import {
  loadConfigurations,
  repositoryName,
  saveConfiguration,
  validateConfig,
  type ReviewConfig,
} from "./configuration";

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const signal = () => AbortSignal.timeout(5000);
const agent = keypair();
const config: ReviewConfig = {
  version: 1,
  repository: "example-org/project",
  reminderMinutes: 15,
  lanes: [
    {
      id: "general",
      name: "General",
      instructions: "Check authorization and tests.",
      reviewers: [agent.pubkey],
      routing: {
        mode: "all",
        rules: [
          { id: "rule", field: "files", operator: "at-least", value: "0" },
        ],
      },
    },
  ],
};

const firstLane = config.lanes[0];
if (!firstLane) throw new Error("Missing lane fixture");

function host() {
  const key = keypair();
  let events: EventData[] = [];
  const profile = reviewAgentProfile(key, agent);
  const snapshotRead = vi.fn(async (filters: { kinds?: number[] }[]) =>
    filters[0]?.kinds?.includes(0) ? [profile] : events,
  );
  const publish = vi.fn(async (event: EventData) => {
    events = [event];
    return event.id;
  });
  const sign = vi.fn(async (template: EventTemplate) => signed(key, template));
  const session = {
    ...reviewTestAccess(key.pubkey, channel, [agent.pubkey]),
    channels: {
      ...reviewTestAccess(key.pubkey, channel).channels,
      list: () => ({
        status: "ready",
        channels: [channel, other].map(
          (id) =>
            reviewTestAccess(key.pubkey, id, [agent.pubkey]).channels.list()
              .channels[0],
        ),
      }),
    },
    snapshotRead,
    configArtifactWriter: { sign, publish },
  } as unknown as RelaySession;
  return { session, snapshotRead, sign, publish };
}

it("creates and reloads a signed configuration, then updates the loaded revision", async () => {
  const test = host();
  const first = await saveConfiguration(
    test.session,
    channel,
    config,
    undefined,
    signal(),
  );
  expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual(["op", "create"]);
  expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual(["h", channel]);
  expect(
    (await loadConfigurations(test.session, channel, signal())).rows,
  ).toEqual([first]);
  expect(test.snapshotRead).toHaveBeenCalledWith(
    [
      {
        kinds: [45010],
        "#h": [channel],
        "#type": ["buzz.review.config"],
        artifact: "current",
        limit: 101,
      },
    ],
    expect.anything(),
  );
  const edited = {
    ...config,
    lanes: [
      {
        ...firstLane,
        instructions: "Check keyboard navigation.",
      },
    ],
  };
  const second = await saveConfiguration(
    test.session,
    channel,
    edited,
    first,
    signal(),
  );
  expect(test.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "prev",
    first.revision,
  ]);
  expect(test.publish.mock.calls[1]?.[0].tags).toContainEqual(["op", "update"]);
  expect(second.artifactId).toBe(first.artifactId);
  expect(
    (await loadConfigurations(test.session, channel, signal())).rows[0]?.config,
  ).toEqual(edited);
});

it("never fetches a newer revision to overwrite a concurrent edit; propagates rejection", async () => {
  const test = host();
  const first = await saveConfiguration(
    test.session,
    channel,
    config,
    undefined,
    signal(),
  );
  test.publish.mockRejectedValueOnce(
    new Error("conflict: artifact head changed"),
  );
  await expect(
    saveConfiguration(test.session, channel, config, first, signal()),
  ).rejects.toThrow("head changed");
  expect(
    test.snapshotRead.mock.calls.every(([filters]) =>
      filters[0]?.kinds?.includes(0),
    ),
  ).toBe(true);
  expect(test.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "prev",
    first.revision,
  ]);
});

it("canonicalizes duplicate repository inputs and scopes identities to the channel", async () => {
  const test = host();
  const first = await saveConfiguration(
    test.session,
    channel,
    config,
    undefined,
    signal(),
  );
  const duplicate = await saveConfiguration(
    test.session,
    channel,
    { ...config, repository: " https://github.com/Example-Org/PROJECT/ " },
    undefined,
    signal(),
  );
  expect(duplicate.artifactId).toBe(first.artifactId);
  const separate = await saveConfiguration(
    test.session,
    other,
    config,
    undefined,
    signal(),
  );
  expect(separate.artifactId).not.toBe(first.artifactId);
  await expect(
    saveConfiguration(test.session, other, config, first, signal()),
  ).rejects.toThrow("new configuration");
});

it.each([
  "https://github.com.evil.example/org/repo",
  "https://user:password@github.com/org/repo",
  "org/repo/pull/1",
  "org/repo?token=secret",
  "org/..",
  "file:///tmp/project",
])("refuses a non-repository input: %s", (input) => {
  expect(() => repositoryName(input)).toThrow("GitHub repository");
});

it("validates stored settings and refuses unsupported versions, duplicate lanes and oversized payloads", () => {
  expect(() => validateConfig({ ...config, version: 2 })).toThrow(
    "Unsupported",
  );
  expect(() => validateConfig({ ...config, lanes: [] })).toThrow(
    "between 1 and 12",
  );
  expect(() =>
    validateConfig({
      ...config,
      lanes: [...config.lanes, { ...config.lanes[0], id: "second" }],
    }),
  ).toThrow("unique");
  expect(() =>
    validateConfig({
      ...config,
      lanes: [{ ...config.lanes[0], instructions: " " }],
    }),
  ).toThrow("instructions");
  expect(() =>
    validateConfig({
      ...config,
      lanes: [{ ...config.lanes[0], instructions: "😀".repeat(4000) }],
    }),
  ).not.toThrow();
  expect(() =>
    validateConfig({
      ...config,
      lanes: Array.from({ length: 3 }, (_, index) => ({
        id: `lane-${index}`,
        name: `Lane ${index}`,
        instructions: "😀".repeat(4000),
      })),
    }),
  ).toThrow("too large");
});

it("isolates unreadable rows and signals a truncated result", async () => {
  const test = host();
  await saveConfiguration(test.session, channel, config, undefined, signal());
  const event = test.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("Expected a published configuration");
  test.snapshotRead.mockResolvedValueOnce([
    event,
    { ...event, content: "{broken" },
  ]);
  const loaded = await loadConfigurations(test.session, channel, signal());
  expect(loaded.rows).toHaveLength(1);
  expect(loaded.unreadable).toBe(1);
  test.snapshotRead.mockResolvedValueOnce([
    {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === "h" ? ["h", other] : tag)),
    },
  ]);
  expect(
    (await loadConfigurations(test.session, channel, signal())).unreadable,
  ).toBe(1);
  test.snapshotRead.mockResolvedValueOnce(
    Array.from({ length: 101 }, () => event),
  );
  expect(
    (await loadConfigurations(test.session, channel, signal())).truncated,
  ).toBe(true);
});

it("validates reviewer identities and reads earlier drafts without reviewers", () => {
  expect(() =>
    validateConfig({
      ...config,
      lanes: [{ ...config.lanes[0], reviewers: ["not-a-key"] }],
    }),
  ).toThrow("reviewer agents");
  expect(() =>
    validateConfig({
      ...config,
      lanes: [
        { ...config.lanes[0], reviewers: ["a".repeat(64), "a".repeat(64)] },
      ],
    }),
  ).toThrow("distinct");
  expect(
    validateConfig({
      ...config,
      lanes: [{ ...config.lanes[0], reviewers: undefined }],
    }).lanes[0]?.reviewers,
  ).toEqual([]);
});

it("requires rules on new or edited lanes while keeping legacy configurations readable", async () => {
  const test = host();
  const legacy = {
    ...config,
    lanes: config.lanes.map(({ routing: _, ...lane }) => lane),
  };
  expect(validateConfig(legacy)).toEqual(legacy);
  await expect(
    saveConfiguration(test.session, channel, legacy, undefined, signal()),
  ).rejects.toThrow("at least one routing rule");
  expect(test.sign).not.toHaveBeenCalled();
  const first = await saveConfiguration(
    test.session,
    channel,
    config,
    undefined,
    signal(),
  );
  const previous = { ...first, config: legacy };
  const added = {
    ...legacy,
    lanes: [...legacy.lanes, { ...firstLane, id: "second", name: "Second" }],
  };
  await expect(
    saveConfiguration(test.session, channel, added, previous, signal()),
  ).resolves.toMatchObject({ config: added });
  const edited = {
    ...legacy,
    lanes: legacy.lanes.map((lane) => ({ ...lane, instructions: "Changed" })),
  };
  await expect(
    saveConfiguration(test.session, channel, edited, previous, signal()),
  ).rejects.toThrow("at least one routing rule");
});

it("keeps legacy defaults and validates optional admission configuration", async () => {
  const { DEFAULT_ADMISSION } = await import("./configuration");
  expect(validateConfig(config).admission).toBeUndefined();
  const admission = {
    ...DEFAULT_ADMISSION,
    ready: true,
    triage: true,
    agent: "a".repeat(64),
    instructions: "Reject duplicates",
  };
  expect(validateConfig({ ...config, admission }).admission).toEqual(admission);
  for (const change of [{ agent: "" }, { instructions: " " }, { ready: "yes" }])
    expect(() =>
      validateConfig({ ...config, admission: { ...admission, ...change } }),
    ).toThrow();
});

it("keeps automatic approval opt-in and rejects non-boolean stored permissions", () => {
  expect(validateConfig(config).lanes[0]?.autoApprove ?? false).toBe(false);
  for (const autoApprove of [false, true]) {
    expect(
      validateConfig({ ...config, lanes: [{ ...firstLane, autoApprove }] })
        .lanes[0]?.autoApprove,
    ).toBe(autoApprove);
  }
  expect(() =>
    validateConfig({
      ...config,
      lanes: [{ ...firstLane, autoApprove: "true" }],
    }),
  ).toThrow();
});
