// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately require their arranged calls, elements and results to exist.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddings, type EmbeddingHost } from "./embed.ts";
import {
  DEFAULT_SETTINGS,
  type Event,
  type MemoryListing,
  type Settings,
} from "./types.ts";
import { recall } from "./recall.ts";
import { CHANNEL, AGENT, OWNER, deps, message, turn } from "./fake.ts";

const unit = () => [1, ...new Array(767).fill(0)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function rig() {
  const requests: {
    url: string;
    body?: string;
    headers?: Readonly<Record<string, string>>;
  }[] = [];
  let gate: Promise<void> | undefined;
  let onEmbedding = () => {};
  let result: unknown = unit();
  const host: EmbeddingHost = {
    request: vi.fn(async (request) => {
      requests.push(request);
      onEmbedding();
      await gate;
      const inputs: string[] = JSON.parse(request.body!).input;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          model: "test-model",
          data: inputs.map((_, index) => ({ index, embedding: result })),
        }),
      };
    }),
  };
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    embeddingUrl: "http://127.0.0.1:8080",
  };
  const embed = createEmbeddings(
    host,
    () => settings,
    () => 0,
  );
  const read = (events: readonly Event[], listing?: MemoryListing) =>
    turn(
      { text: "Which pet?" },
      {
        events: async (f) =>
          events.filter((e) => !f.ids || f.ids.includes(e.id)),
        channel: async () => ({
          visibility: "private",
          complete: true,
          members: [OWNER, AGENT],
        }),
        memories: async () => listing ?? { entries: [], partial: false },
      },
    );
  return {
    embed,
    host,
    requests,
    read,
    block: (p: Promise<void>) => {
      gate = p;
    },
    onEmbedding: (f: () => void) => {
      onEmbedding = f;
    },
    badVector: (v: unknown) => {
      result = v;
    },
    settings: (s: Settings) => {
      settings = { embeddingUrl: "http://127.0.0.1:8080", ...s };
    },
  };
}
async function observed(
  r: ReturnType<typeof rig>,
  t = r.read([message("dog", "Bought a Labrador")]),
) {
  (await r.embed.observe(t))();
  await r.embed.idle();
  return t;
}
afterEach(() => vi.useRealTimers());

describe("bounded final embedding input", () => {
  it.each(["message", "memory"] as const)(
    "bounds queued %s text before inference",
    async (kind) => {
      const r = rig();
      await r.embed.enable();
      vi.useFakeTimers(); // Keep the queued snapshot from draining.
      try {
        const text = "x".repeat(64 * 1024);
        const t = r.read(kind === "message" ? [message("large", text)] : [], {
          entries:
            kind === "memory"
              ? [{ slug: "mem/large", body: text, createdAt: 1 }]
              : [],
          partial: false,
        });
        (await r.embed.observe(t))();
        expect(r.requests.filter((request) => request.body)).toHaveLength(0);
        expect(r.embed.queuedBytes()).toBe(4000);
      } finally {
        await r.embed.disable();
        vi.useRealTimers();
      }
    },
  );
  it("indexes all 16 siblings with a maximal high-density row and bounds queries too", async () => {
    const r = rig();
    await r.embed.enable();
    const request = vi.mocked(r.host.request).getMockImplementation()!;
    const normalizedBytes = (text: string) =>
      new TextEncoder().encode(text).length;
    vi.mocked(r.host.request).mockImplementation(async (input) => {
      if (input.body) {
        const values: string[] = JSON.parse(input.body).input;
        if (values.some((text) => normalizedBytes(text) > 4000))
          throw new Error("slot overflow");
      }
      return request(input);
    });
    const dense = "🧬龘 ".repeat(2048);
    const events = Array.from({ length: 16 }, (_, i) =>
      message(`row-${i}`, i === 0 ? dense : `short ${i}`),
    );
    const t = await observed(r, r.read(events));
    expect(r.embed.size()).toBe(16);
    const batch: string[] = JSON.parse(
      r.requests.find((x) => x.body)!.body!,
    ).input;
    expect(batch).toHaveLength(16);
    expect(normalizedBytes(batch[0]!)).toBeGreaterThan(3990);
    expect(
      batch.every(
        (text) => normalizedBytes(text) <= 4000 && !text.includes("\uFFFD"),
      ),
    ).toBe(true);
    expect(await r.embed.neighbours({ ...t, text: dense })).toHaveLength(16);
    const query: string = JSON.parse(r.requests.at(-1)!.body!).input[0];
    expect(query.startsWith("🧬龘 ")).toBe(true);
    expect(normalizedBytes(query)).toBeLessThanOrEqual(4000);
    await r.embed.disable();
  });
});

describe("I-REST: copied snapshots and fenced RAM", () => {
  it("a fast turn copies parallel leased history before settling and builds its index", async () => {
    const r = rig();
    await r.embed.enable();
    const gate = deferred<void>();
    let live = true;
    const base = r.read([message("dog", "Bought a Labrador")]);
    const events = vi.fn(async () => {
      await gate.promise;
      if (!live) throw new Error("revoked");
      return base.reads.events({ kinds: [9], limit: 500 });
    });
    const t = {
      ...base,
      text: "the and of",
      reads: {
        ...base.reads,
        events,
        channel: async (id: string) => {
          await gate.promise;
          if (!live) throw new Error("revoked");
          return base.reads.channel(id);
        },
      },
    };
    const result = recall(t, deps({ semantic: r.embed })).finally(() => {
      live = false;
    });
    // The event read must start while the channel read is still held.
    expect(events).toHaveBeenCalledTimes(1);
    gate.resolve();
    await result;
    await r.embed.idle();
    expect(await r.embed.neighbours(base)).toEqual([
      expect.objectContaining({ id: "dog" }),
    ]);
    await r.embed.disable();
  });

  it("copies while leased but waits for the caller's post-run callback to embed; retains no reads", async () => {
    const r = rig();
    await r.embed.enable();
    const events = vi.fn(async () => [message("dog", "Bought a Labrador")]);
    const t = turn({}, { events });
    const commit = await r.embed.observe(t);
    expect(r.requests.filter((x) => x.body)).toHaveLength(0);
    events.mockRejectedValue(new Error("lease revoked"));
    commit();
    await r.embed.idle();
    expect(r.embed.size()).toBe(1);
    expect(events).toHaveBeenCalledTimes(1);
    await r.embed.disable();
  });
  it("queues nothing when a pending snapshot read rejects at lease revocation", async () => {
    const r = rig();
    await r.embed.enable();
    const read = deferred<readonly Event[]>();
    let live = true;
    const snapshot = r.embed.observe(
      turn(
        {},
        {
          events: async () => {
            const result = await read.promise;
            if (!live) throw new Error("revoked");
            return result;
          },
        },
      ),
    );
    live = false;
    read.resolve([message("late", "secret")]);
    (await snapshot)();
    await r.embed.idle();
    expect(r.embed.size()).toBe(0);
    expect(r.requests.filter((x) => x.body)).toHaveLength(0);
    await r.embed.disable();
  });
  it("disable fences a copied snapshot whose post-run callback has not fired yet", async () => {
    const r = rig();
    await r.embed.enable();
    const copied = await r.embed.observe(r.read([message("dog", "discarded")]));
    await r.embed.disable();
    await r.embed.enable();
    copied();
    await r.embed.idle();
    expect(r.embed.size()).toBe(0);
    await r.embed.disable();
  });
  it("disable fences a running job so it cannot repopulate RAM", async () => {
    const r = rig();
    await r.embed.enable();
    const gate = deferred<void>();
    const started = deferred<void>();
    r.block(gate.promise);
    r.onEmbedding(() => started.resolve());
    (await r.embed.observe(r.read([message("dog", "secret")])))();
    const done = r.embed.idle();
    await started.promise;
    await r.embed.disable();
    await r.embed.enable();
    gate.resolve();
    await done;
    expect(r.embed.size()).toBe(0);
    await r.embed.disable();
  });
  it.each(["owner", "community", "agent"] as const)(
    "a changed %s isolates banks without discarding the previous index",
    async (field) => {
      const r = rig();
      await r.embed.enable();
      const t = await observed(r);
      expect(r.embed.size()).toBe(1);
      expect(await r.embed.neighbours({ ...t, [field]: "different" })).toEqual(
        [],
      );
      expect(await r.embed.neighbours(t)).toHaveLength(1);
      await r.embed.disable();
    },
  );
  it("one pending snapshot per channel, newer replaces older", async () => {
    const r = rig();
    await r.embed.enable();
    const old = await r.embed.observe(r.read([message("old", "old")]));
    const latest = await r.embed.observe(r.read([message("latest", "new")]));
    old();
    latest();
    await r.embed.idle();
    expect(r.embed.size()).toBe(1);
    const calls = r.requests.filter((x) => x.body);
    expect(JSON.parse(calls[0]!.body!).input).toEqual(["new"]);
    await r.embed.disable();
  });
  it("globally caps vectors and evicts the least recently used channel", async () => {
    const r = rig();
    await r.embed.enable();
    for (let i = 0; i < 41; i++) {
      const id = `channel-${i}`;
      await observed(
        r,
        turn(
          { channel: id },
          {
            events: async () =>
              Array.from({ length: 500 }, (_, j) =>
                message(`${i}-${j}`, "text", { tags: [["h", id]] }),
              ),
          },
        ),
      );
      expect(r.embed.size()).toBeLessThanOrEqual(20000);
    }
    expect(r.embed.size()).toBe(20000);
    expect(await r.embed.neighbours(turn({ channel: "channel-0" }))).toEqual(
      [],
    );
    await r.embed.disable();
  });
});

describe("I-FRESH/I-MEM/I-FLOW: vectors are not permissions", () => {
  it("relay scope searches observed channels, while channel scope and audience still constrain hits", async () => {
    const r = rig();
    await r.embed.enable();
    const source = await observed(r);
    const destination = { ...source, channel: "destination" };
    expect(await r.embed.neighbours(destination)).toEqual([]);
    r.settings({ ...DEFAULT_SETTINGS, scope: "relay" });
    expect(await r.embed.neighbours(destination)).toEqual([
      expect.objectContaining({ id: "dog", channel: CHANNEL }),
    ]);
    const denied = {
      ...destination,
      reads: {
        ...destination.reads,
        channel: async (id: string) => ({
          visibility: "private" as const,
          complete: true,
          members: id === CHANNEL ? [OWNER, AGENT] : [OWNER, AGENT, "outsider"],
        }),
      },
    };
    expect(await r.embed.neighbours(denied)).toEqual([]);
    expect(
      await r.embed.neighbours({ ...destination, agent: "different" }),
    ).toEqual([]);
    await r.embed.disable();
  });
  it("disallowed memory vectors cannot displace an eligible message from the shortlist", async () => {
    const r = rig();
    await r.embed.enable();
    await observed(
      r,
      r.read([], {
        entries: [
          {
            slug: "mem/many",
            createdAt: 1,
            body: Array.from({ length: 41 }, (_, i) => `line ${i}`).join("\n"),
          },
        ],
        partial: false,
      }),
    );
    r.badVector([0.8, 0.6, ...new Array(766).fill(0)]);
    const t = await observed(
      r,
      r.read([message("dog", "Bought a Labrador")], {
        entries: [],
        partial: true,
      }),
    );
    expect(r.embed.size()).toBe(42);
    r.badVector(unit()); // Memories score above the message, so admitting them would exhaust the shortlist.
    const shared = {
      ...t,
      reads: {
        ...t.reads,
        channel: async () => ({
          visibility: "open" as const,
          members: [],
          complete: true,
        }),
      },
    };
    expect(await r.embed.neighbours(shared)).toEqual([
      expect.objectContaining({ id: "dog" }),
    ]);
    await r.embed.disable();
  });
  it("requires the message in the consuming lease and never injects stored text", async () => {
    const r = rig();
    await r.embed.enable();
    const t = await observed(r);
    expect(await r.embed.neighbours(t)).toHaveLength(1);
    expect(await r.embed.neighbours(r.read([]))).toEqual([]);
    const changed = r.read([message("dog", "current text")]);
    expect((await r.embed.neighbours(changed))[0]!.text).toBe("current text");
    await r.embed.disable();
  });
  it("drops a hit when revalidation fails or the deadline passes", async () => {
    const r = rig();
    await r.embed.enable();
    const t = await observed(r);
    expect(
      await r.embed.neighbours(
        turn(
          {},
          {
            ...t.reads,
            events: async () => {
              throw new Error("revoked");
            },
          },
        ),
      ),
    ).toEqual([]);
    expect(await r.embed.neighbours({ ...t, deadline: 0 })).toEqual([]);
    await r.embed.disable();
  });
  it("memory requires a current version, no tombstone and this turn's disclosure permission", async () => {
    const r = rig();
    await r.embed.enable();
    const entry = { slug: "mem/pets", createdAt: 100, body: "Labrador" };
    const t = await observed(
      r,
      r.read([], { entries: [entry], partial: false }),
    );
    expect(await r.embed.neighbours(t)).toEqual([
      expect.objectContaining({ id: "mem/pets#0" }),
    ]);
    expect(
      await r.embed.neighbours(
        r.read([], { entries: [{ ...entry, createdAt: 101 }], partial: false }),
      ),
    ).toEqual([]);
    expect(
      await r.embed.neighbours(
        r.read([], {
          entries: [entry],
          deleted: [
            { slug: entry.slug, createdAt: 100 },
            { slug: entry.slug, createdAt: 1 },
          ],
          partial: false,
        }),
      ),
    ).toEqual([]);
    const publicTurn = {
      ...t,
      reads: {
        ...t.reads,
        channel: async () => ({
          visibility: "open" as const,
          complete: true,
          members: [],
        }),
      },
    };
    expect(await r.embed.neighbours(publicTurn)).toEqual([]);
    await r.embed.disable();
  });
  it("prunes 40 superseded memory versions before selecting neighbours", async () => {
    const r = rig();
    await r.embed.enable();
    let t = r.read([]);
    for (let version = 1; version <= 41; version++) {
      t = r.read([], {
        entries: [{ slug: "mem/pets", createdAt: version, body: "Labrador" }],
        partial: false,
      });
      await observed(r, t);
    }
    expect(r.embed.size()).toBe(1);
    expect(await r.embed.neighbours(t)).toEqual([
      expect.objectContaining({ id: "mem/pets#0", at: 41 }),
    ]);
    await observed(r, r.read([], { entries: [], partial: false }));
    expect(r.embed.size()).toBe(0);
    await r.embed.disable();
  });
  it("late older snapshot cannot replace a newer accepted snapshot", async () => {
    const r = rig();
    await r.embed.enable();
    const old = await r.embed.observe(
      r.read([], {
        entries: [{ slug: "mem/pets", createdAt: 1, body: "old" }],
        partial: false,
      }),
    );
    const t = r.read([], {
      entries: [{ slug: "mem/pets", createdAt: 2, body: "new" }],
      partial: false,
    });
    const newer = await r.embed.observe(t);
    newer();
    await r.embed.idle();
    old();
    await r.embed.idle();
    expect(r.embed.size()).toBe(1);
    expect(await r.embed.neighbours(t)).toEqual([
      expect.objectContaining({ text: "new", at: 2 }),
    ]);
    await r.embed.disable();
  });
  it("reuses mayFlow when a reread source is private and target is open", async () => {
    const r = rig();
    await r.embed.enable();
    const t = await observed(r);
    const cross = {
      ...t,
      reads: {
        ...t.reads,
        events: async () => [
          message("dog", "secret", { tags: [["h", "other"]] }),
        ],
        channel: async (id: string) => ({
          visibility: id === CHANNEL ? ("open" as const) : ("private" as const),
          complete: true,
          members: [OWNER],
        }),
      },
    };
    expect(await r.embed.neighbours(cross)).toEqual([]);
    await r.embed.disable();
  });
});

describe("endpoint changes and failures", () => {
  it.each(["embeddingUrl", "queryPrefix", "documentPrefix"] as const)(
    "changing %s clears indexed and queued text",
    async (field) => {
      const r = rig();
      const t = await observed(r);
      const copied = await r.embed.observe(
        r.read([message("late", "old server text")]),
      );
      r.settings({
        ...DEFAULT_SETTINGS,
        [field]: field === "embeddingUrl" ? "https://new.test" : "new prefix",
      });
      r.embed.refresh();
      copied();
      await r.embed.idle();
      expect(r.embed.size()).toBe(0);
      expect(await r.embed.neighbours(t)).toEqual([]);
      await observed(r);
      expect(r.embed.size()).toBe(1);
      await r.embed.disable();
    },
  );
  it("empty URL performs no reads or requests", async () => {
    const r = rig();
    r.settings({ ...DEFAULT_SETTINGS, embeddingUrl: "" });
    const reads = vi.fn(async () => []);
    (await r.embed.observe(turn({}, { events: reads })))();
    expect(await r.embed.neighbours(turn({}, { events: reads }))).toEqual([]);
    await r.embed.idle();
    expect(reads).not.toHaveBeenCalled();
    expect(r.host.request).not.toHaveBeenCalled();
  });
  it("a returned model change discards old vectors even when dimensions match", async () => {
    const r = rig();
    const t = await observed(r);
    const original = vi.mocked(r.host.request).getMockImplementation()!;
    vi.mocked(r.host.request).mockImplementation(async (input) => {
      const result = await original(input);
      return {
        ...result,
        body: JSON.stringify({
          ...JSON.parse(result.body),
          model: "new-model",
        }),
      };
    });
    expect(await r.embed.neighbours(t)).toEqual([]);
    expect(r.embed.size()).toBe(0);
    await observed(r);
    expect(await r.embed.neighbours(t)).toHaveLength(1);
    await r.embed.disable();
  });
  it("a hung server receives exactly one request per snapshot", async () => {
    vi.useFakeTimers();
    const r = rig();
    const gate = deferred<void>();
    r.block(gate.promise);
    const t = r.read(
      Array.from({ length: 17 }, (_, i) => message(`m-${i}`, `text ${i}`)),
    );
    try {
      for (let snapshot = 1; snapshot <= 2; snapshot++) {
        (await r.embed.observe(t))();
        await vi.runAllTimersAsync();
        await r.embed.idle();
        expect(r.host.request).toHaveBeenCalledTimes(snapshot);
        expect(r.embed.size()).toBe(0);
      }
    } finally {
      gate.resolve();
      await r.embed.disable();
    }
  });
  it.each(["transport", "malformed"])(
    "stops a snapshot after a %s failure and recovers on the next",
    async (failure) => {
      const r = rig();
      const request = vi.mocked(r.host.request);
      if (failure === "transport")
        request.mockRejectedValueOnce(new Error("offline"));
      else
        request.mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: "invalid",
        });
      const t = r.read(
        Array.from({ length: 17 }, (_, i) => message(`m-${i}`, `text ${i}`)),
      );
      await observed(r, t);
      expect(request).toHaveBeenCalledTimes(1);
      expect(r.embed.size()).toBe(0);
      await observed(r, t);
      expect(request).toHaveBeenCalledTimes(3);
      expect(r.embed.size()).toBe(17);
      await r.embed.disable();
    },
  );
  it.each([400, 500, 503])(
    "an HTTP %s batch fails once while later batches still index",
    async (status) => {
      const r = rig();
      // llama-server b11669 at -ub 512 returned 500 for 4000 bytes / 3881 tokens,
      // including with a short sibling; a later short request succeeded.
      vi.mocked(r.host.request).mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({
          error: {
            code: status,
            message:
              "input (3881 tokens) is too large to process. increase the physical batch size (current batch size: 512)",
            type: "server_error",
          },
        }),
      });
      await observed(
        r,
        r.read(
          Array.from({ length: 17 }, (_, i) => message(`m-${i}`, `text ${i}`)),
        ),
      );
      expect(r.host.request).toHaveBeenCalledTimes(2);
      expect(r.embed.size()).toBe(1);
      await r.embed.idle();
      expect(r.host.request).toHaveBeenCalledTimes(2);
      await r.embed.disable();
    },
  );
  it("uses optional prefixes and limits query timeout to the remaining turn budget", async () => {
    const r = rig();
    r.settings({
      ...DEFAULT_SETTINGS,
      queryPrefix: "q: ",
      documentPrefix: "d: ",
    });
    const t = await observed(r);
    expect(JSON.parse(r.requests[0]!.body!).input).toEqual([
      "d: Bought a Labrador",
    ]);
    await r.embed.neighbours({ ...t, deadline: 27 });
    expect(JSON.parse(r.requests.at(-1)!.body!).input).toEqual([
      "q: Which pet?",
    ]);
    expect(vi.mocked(r.host.request).mock.calls.at(-1)![0].timeoutMs).toBe(27);
    await r.embed.neighbours({ ...t, deadline: 5000 });
    expect(vi.mocked(r.host.request).mock.calls.at(-1)![0].timeoutMs).toBe(
      1000,
    );
    await r.embed.disable();
  });
  it("a newer snapshot fences an already running batch", async () => {
    const r = rig();
    const gate = deferred<void>();
    const started = deferred<void>();
    r.block(gate.promise);
    r.onEmbedding(() => started.resolve());
    (await r.embed.observe(r.read([message("old", "old")])))();
    const done = r.embed.idle();
    await started.promise;
    (await r.embed.observe(r.read([message("new", "new")])))();
    gate.resolve();
    await done;
    await r.embed.idle();
    expect(r.embed.size()).toBe(1);
    expect(await r.embed.neighbours(r.read([message("old", "old")]))).toEqual(
      [],
    );
    expect(
      await r.embed.neighbours(r.read([message("new", "new")])),
    ).toHaveLength(1);
    await r.embed.disable();
  });
});
