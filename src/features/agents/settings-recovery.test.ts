import { describe, expect, it } from "vitest";
import type { ConfigHistory } from "./service";
import { artifactTemplate } from "./agent-config-artifacts";
import { repairedSettings, settingsRecovery } from "./settings-recovery";
import { createConfigWriter, type WriteSide } from "./config-writes";
import { AgentConfigStore, syncedSettings } from "./agent-config";
import { memoryStorage } from "./test-fakes";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { PublishRejected } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";

const expected = {
  channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
  d: "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e",
  type: "buzz.agent.settings" as const,
};
const check = {
  agentType: "example/echo",
  schema: {
    model: "string",
    scope: ["thread", "channel"],
    effort: ["low", "high"],
  },
} as const;
const key = generateSecretKey();
function fixture(
  settings: object = { scope: "community", voice: "maple", effort: "high" },
) {
  const body = {
    version: 1,
    agentType: check.agentType,
    settings,
    future: { keep: true },
  };
  const head = finalizeEvent(
    artifactTemplate({
      ...expected,
      op: "create",
      title: "Agent settings",
      content: JSON.stringify(body),
    }),
    key,
  ) as RelayEvent;
  const history = {
    sides: [{ side: "settings", expected, head, version: 1 }],
    settings: check,
    read: async () => [],
    revise: async () => ({ status: "accepted" }),
  } as ConfigHistory;
  const recovery = settingsRecovery(history);
  return { body, head, history, recovery };
}
describe("settings recovery", () => {
  it("only offers repair for incompatible values in a valid current-type settings envelope", () => {
    const f = fixture();
    expect(f.recovery?.fields.map((field) => field.name)).toEqual([
      "scope",
      "voice",
    ]);
    expect(settingsRecovery(undefined)).toBeUndefined();
    expect(
      settingsRecovery(fixture({ scope: "thread" }).history),
    ).toBeUndefined();
    for (const content of [
      "{",
      "[]",
      JSON.stringify({
        version: 1,
        agentType: "other/type",
        settings: { scope: "bad" },
      }),
    ]) {
      expect(
        settingsRecovery({
          ...f.history,
          sides: [
            { ...required(f.history.sides[0]), head: { ...f.head, content } },
          ],
        }),
      ).toBeUndefined();
    }
  });
  it("removes only explicitly reviewed invalid fields and preserves extensions", () => {
    const f = fixture();
    const result = repairedSettings(required(f.recovery), {
      scope: undefined,
      voice: undefined,
    });
    expect(JSON.parse(result.content)).toEqual({
      ...f.body,
      settings: { effort: "high" },
    });
    expect(result.tags).toContainEqual(["prev", f.head.id]);
    expect(() =>
      repairedSettings(required(f.recovery), { scope: "thread" }),
    ).toThrow(/every setting/);
    expect(() =>
      repairedSettings(required(f.recovery), {
        scope: "bad",
        voice: undefined,
      }),
    ).toThrow(/unsupported value/);
    expect(() =>
      repairedSettings(required(f.recovery), {
        scope: "thread",
        voice: "keep",
      }),
    ).toThrow(/must be removed/);
    expect(JSON.parse(f.head.content)).toEqual(f.body);
  });
  it("writes a signed repair through the production writer, reads it back, and conflicts on a stale repair", async () => {
    const f = fixture();
    let head = f.head;
    const store = new AgentConfigStore(memoryStorage());
    const side: WriteSide = {
      subject: {
        owner: "owner",
        community: "https://relay.example",
        subject: "agent",
        channel: expected.channel,
        type: expected.type,
      },
      expected,
      title: "Agent settings",
    };
    const writer = createConfigWriter({
      store,
      read: async () => [head],
      online: () => true,
      maxEventBytes: 512 * 1024,
      signal: new AbortController().signal,
      writer: {
        sign: async (template) => finalizeEvent(template, key) as RelayEvent,
        publish: async (event) => {
          if (event.tags.find(([name]) => name === "prev")?.[1] !== head.id)
            throw new PublishRejected("conflict", "stale prev");
          head = event;
        },
      },
    });
    const template = repairedSettings(required(f.recovery), {
      scope: "channel",
      voice: undefined,
    });
    expect(await writer.revise(side, template, f.head.id)).toMatchObject({
      status: "saved",
    });
    expect(store.state(side.subject).head?.id).toBe(head.id);
    expect(syncedSettings(head.content, check.agentType, check.schema)).toEqual(
      { settings: { scope: "channel", effort: "high" } },
    );
    expect(await writer.revise(side, template, f.head.id)).toMatchObject({
      status: "conflict",
    });
    expect(JSON.parse(head.content).settings.scope).toBe("channel");
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
