import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { fakeAmp, init, result, type Script } from "./amp-testing";
import { AmpRuntime, DEFAULT_CONFIG } from "./runtime";

const self = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const channel = "chan-1";
const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;
const reply = (id: string, content: string, root: string) =>
  message(id, content, {
    tags: [
      ["h", channel],
      ["e", root.repeat(64).slice(0, 64), "", "reply"],
      ["p", self],
    ],
  });

function setup(script: Script) {
  const fake = fakeAmp(script);
  const host = {
    spawn: fake.host.spawn,
    serveMcp: fake.host.serve,
    readFile: vi.fn(),
    request: vi.fn(),
  } as unknown as Host;
  const session = {
    read: vi.fn(async () => []),
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
    channelWrites: { startingCanvas: () => undefined },
    canvas: { available: false, read: vi.fn(async () => null) },
  };
  const relay = {
    snapshot: () => ({
      status: "ready",
      session,
      viewer: alice,
      scope: `https://amp.example:${alice}`,
    }),
  } as unknown as RelayData;
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const runtime = new AmpRuntime(
    host,
    () => relay,
    async () => null,
    storage,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Ampy",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return template;
    }),
  };
  const working: PromiseLike<unknown>[] = [];
  const deliver = async (event: RelayEvent, extra: Partial<Delivery> = {}) => {
    const ignored = vi.fn();
    await runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
      workingUntil: (done: PromiseLike<unknown>) => void working.push(done),
      ignored,
      ...extra,
    } as unknown as Delivery);
    return { ignored, done: working.at(-1) };
  };
  return { fake, runtime, agent, published, deliver, storage };
}

describe("AmpRuntime", () => {
  it("ignores a mention from someone other than its owner", async () => {
    const { deliver, fake } = setup(async () => ({}));
    const { ignored } = await deliver(message("1", "hi", { pubkey: bob }));
    expect(ignored).toHaveBeenCalled();
    expect(fake.started).toHaveLength(0);
  });

  it("opens a thread with Buzz's prompt, then continues it in the same Buzz thread", async () => {
    const { deliver, fake, published } = setup(async ({ args }) => {
      const thread = args[0] === "threads" ? (args[2] ?? "") : "T-1";
      return { stdout: [init(thread), result(thread, "pong")] };
    });
    const first = message("1", "@Ampy ping");
    await (await deliver(first)).done;
    expect(fake.started[0]?.args).not.toContain("continue");
    expect(fake.started[0]?.args).toContain("--no-archive-after-execute");
    expect(fake.started[0]?.prompt).toContain("<buzz-system-prompt>");
    expect(fake.started[0]?.prompt).toContain("Content: @Ampy ping");
    expect(fake.started[0]?.cwd).toBe("~/.buzz");
    // Amp answered in text, so it is posted in the thread.
    expect(published.at(-1)).toEqual({
      kind: 9,
      content: "pong",
      tags: [
        ["h", channel],
        ["e", first.id, "", "reply"],
      ],
    });
    await (await deliver(reply("2", "@Ampy again", "1"))).done;
    expect(fake.started[1]?.args.slice(0, 3)).toEqual([
      "threads",
      "continue",
      "T-1",
    ]);
    expect(fake.started[1]?.prompt).not.toContain("buzz-system-prompt");
    // Another Buzz thread is another Amp thread.
    await (await deliver(message("3", "@Ampy elsewhere"))).done;
    expect(fake.started[2]?.args).not.toContain("continue");
  });

  it("starts the thread again when Amp cannot continue it", async () => {
    let calls = 0;
    const { deliver, fake, published } = setup(async () => {
      calls++;
      if (calls === 2)
        return { stderr: "Error: This thread is archived.\n", code: 0 };
      const thread = calls === 1 ? "T-1" : "T-2";
      return { stdout: [init(thread), result(thread, `answer ${calls}`)] };
    });
    await (await deliver(message("1", "@Ampy one"))).done;
    await (await deliver(reply("2", "@Ampy two", "1"))).done;
    expect(fake.started).toHaveLength(3);
    expect(fake.started[2]?.args).not.toContain("continue");
    expect(fake.started[2]?.prompt).toContain("<buzz-system-prompt>");
    expect(published.at(-1)?.content).toBe("answer 3");
    await (await deliver(reply("3", "@Ampy three", "1"))).done;
    expect(fake.started[3]?.args.slice(0, 3)).toEqual([
      "threads",
      "continue",
      "T-2",
    ]);
  });

  it("says in the thread that a turn failed, tagging the owner", async () => {
    const { deliver, published } = setup(async () => ({
      stdout: [init("T-1"), result("T-1", "Out of credits", true)],
    }));
    await (await deliver(message("1", "@Ampy hi"))).done;
    expect(published.at(-1)?.content).toBe(
      "⚠️ I couldn't finish that: Out of credits",
    );
    expect(published.at(-1)?.tags).toContainEqual(["p", alice]);
  });

  it("runs a conversation's turns one at a time, and Stop ends one", async () => {
    const releases: (() => void)[] = [];
    const { deliver, fake, runtime, published } = setup(
      async ({ args, killed }) => {
        await Promise.race([
          new Promise<void>((resolve) => releases.push(resolve)),
          killed,
        ]);
        const thread = args[0] === "threads" ? (args[2] ?? "") : "T-1";
        return { stdout: [init(thread), result(thread, "done")] };
      },
    );
    let stop: (() => Promise<void>) | undefined;
    const first = await deliver(message("1", "@Ampy one"), {
      interruptible: (next: () => Promise<void>) => {
        stop = next;
      },
    } as Partial<Delivery>);
    const second = await deliver(reply("2", "@Ampy two", "1"));
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(runtime.sessions(self)).toEqual([
      { key: `${channel}/${"1".repeat(64)}`, busy: true },
    ]);
    await stop?.();
    await first.done;
    // A stopped turn posts nothing; the next starts after it.
    expect(published).toHaveLength(0);
    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    releases.at(-1)?.();
    await second.done;
    expect(published.at(-1)?.content).toBe("done");
  });

  it("runs a standalone turn in a one-off thread", async () => {
    const { runtime, fake, agent } = setup(async () => ({
      stdout: [init("T-9"), result("T-9", "checked")],
    }));
    const outcome = await runtime.runOnce({
      delivery: { agent, channelId: channel, config: DEFAULT_CONFIG },
      key: "timer/x #1",
      signal: new AbortController().signal,
      prompt: async () => "Check the build",
    } as unknown as Parameters<AmpRuntime["runOnce"]>[0]);
    expect(outcome).toEqual({ ok: true });
    expect(fake.started[0]?.args).not.toContain("--no-archive-after-execute");
    expect(fake.started[0]?.prompt).toContain("Check the build");
    expect(runtime.conversations(self)).toEqual([]);
  });
});
