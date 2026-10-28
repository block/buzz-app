import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
} from "../relay/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { prepareMarkdown } from "./markdown-preparation";
import {
  createMarkdownPreparation,
  preparedMarkdown,
  takeMarkdownTree,
} from "./markdown-worker";
import {
  parseMessageMarkdown,
  type MarkdownPreparationReply,
  type MarkdownPreparationRequest,
} from "./message-markdown-tree";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage?: (event: MessageEvent<MarkdownPreparationReply>) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: (event: MessageEvent) => void;
  requests: MarkdownPreparationRequest[] = [];
  terminated = false;
  constructor() {
    ControlledWorker.instances.push(this);
  }
  postMessage(request: MarkdownPreparationRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(index = 0) {
    const request = this.requests[index];
    if (!request) throw new Error("No request to reply to");
    this.onmessage?.({
      data: {
        id: request.id,
        results: request.contents.map(({ content, parse }) => ({
          content,
          prepared: prepareMarkdown(content),
          tree: parse ? parseMessageMarkdown(content) : undefined,
          preparedBytes: content.length * 2,
          treeBytes: 100,
        })),
      },
    } as MessageEvent<MarkdownPreparationReply>);
  }
}
const owners: ReturnType<typeof createMarkdownPreparation>[] = [];
const owner = () => {
  const preparation = createMarkdownPreparation();
  owners.push(preparation);
  return preparation;
};
const row = (content: string): ChannelMessage => ({
  id: content,
  channelId: "test",
  authorId: "author",
  createdAt: 1,
  content,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});
const worker = () => {
  const current = ControlledWorker.instances.at(-1);
  if (!current) throw new Error("No worker");
  return current;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("DEV", false);
  vi.stubGlobal("Worker", ControlledWorker);
  ControlledWorker.instances = [];
});
afterEach(() => {
  for (const preparation of owners.splice(0)) preparation.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("older-page Markdown preparation", () => {
  it("uses the exact source and consumes mutable trees once", async () => {
    const content = "**prepared** body";
    const waiting = owner().prepare(
      [row(content)],
      new AbortController().signal,
    );
    worker().reply();
    await waiting;
    expect(preparedMarkdown(content)).toEqual(prepareMarkdown(content));
    expect(preparedMarkdown(`${content} edited`)).toBeUndefined();
    expect(takeMarkdownTree(content)).toEqual(parseMessageMarkdown(content));
    expect(takeMarkdownTree(content)).toBeUndefined();
  });

  it("falls back at 100ms and stops the stalled work", async () => {
    let settled = false;
    const preparation = owner();
    const waiting = preparation
      .prepare([row("*stalled*")], new AbortController().signal)
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(worker().terminated).toBe(true);
    worker().reply();
    expect(preparedMarkdown("*stalled*")).toBeUndefined();
    await preparation.prepare([row("*next*")], new AbortController().signal);
    expect(ControlledWorker.instances).toHaveLength(1);
  });

  it("cancels work and permits a fresh worker after navigation", async () => {
    const preparation = owner();
    const controller = new AbortController();
    const waiting = preparation.prepare([row("*old*")], controller.signal);
    const old = worker();
    controller.abort();
    await waiting;
    expect(old.terminated).toBe(true);
    expect(old.onerror).toBeNull();
    expect(old.onmessageerror).toBeNull();
    const next = preparation.prepare(
      [row("*new*")],
      new AbortController().signal,
    );
    old.reply();
    expect(preparedMarkdown("*old*")).toBeUndefined();
    worker().reply();
    await next;
    expect(preparedMarkdown("*new*")).toBeDefined();
  });

  it("fences a resolved reply when its owner clears before the continuation", async () => {
    const preparation = owner();
    const waiting = preparation.prepare(
      [row("*purged*")],
      new AbortController().signal,
    );
    worker().reply();
    preparation.clear();
    await waiting;
    expect(preparedMarkdown("*purged*")).toBeUndefined();
    expect(takeMarkdownTree("*purged*")).toBeUndefined();
  });

  it("clears only the disposing owner's results", async () => {
    const first = owner(),
      second = owner();
    const a = first.prepare(
      [row("*community A*")],
      new AbortController().signal,
    );
    worker().reply();
    await a;
    const b = second.prepare(
      [row("*community B*")],
      new AbortController().signal,
    );
    worker().reply();
    await b;
    first.clear();
    expect(preparedMarkdown("*community A*")).toBeUndefined();
    expect(preparedMarkdown("*community B*")).toBeDefined();
  });

  it.each(["error", "messageerror"])(
    "settles pending work after %s",
    async (kind) => {
      const preparation = owner();
      const waiting = preparation.prepare(
        [row("*failed*")],
        new AbortController().signal,
      );
      const event = { preventDefault: vi.fn() };
      if (kind === "error") worker().onerror?.(event as unknown as ErrorEvent);
      else worker().onmessageerror?.(event as unknown as MessageEvent);
      await waiting;
      expect(worker().terminated).toBe(true);
      expect(preparedMarkdown("*failed*")).toBeUndefined();
    },
  );

  it("retains ordinary preparation but avoids trees for protected inputs", async () => {
    const rows = [
      { ...row("@person **hello**"), mentions: ["person"] },
      row("secret ||spoiler||"),
      row("encoded &#58; punctuation"),
      row("**ordinary**"),
    ];
    const waiting = owner().prepare(rows, new AbortController().signal);
    expect(worker().requests[0]?.contents.map(({ parse }) => parse)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    worker().reply();
    await waiting;
    expect(preparedMarkdown("@person **hello**")).toBeDefined();
    expect(takeMarkdownTree("@person **hello**")).toBeUndefined();
    expect(takeMarkdownTree("**ordinary**")).toBeDefined();
  });
});

it.each(["traffic", "revocation"])(
  "keeps %s authoritative while older-page preparation waits",
  async (scenario) => {
    const relay = keypair(),
      viewer = keypair(),
      author = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live: LiveCallbacks | undefined;
    const session = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const q = session.session.channels;
    try {
      q.ensureList();
      wire
        .next()
        .respond([
          roster(relay, "a", [viewer.pubkey]),
          metadata(relay, "a", "A"),
        ]);
      await vi.advanceTimersByTimeAsync(0);
      q.ensure("a");
      const head = message(author, "a", "**head**", 20);
      wire.next().respond([
        head,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: { created_at: 20, id: head.id },
        }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      wire.next().respond([profile(author, { name: "Author" })]);
      await vi.advanceTimersByTimeAsync(0);
      q.loadOlder("a");
      const older = message(author, "a", "**older**", 10);
      wire.next().respond([
        older,
        bounds(relay, "a", `20:${head.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(worker().requests).toHaveLength(1);
      expect(q.window("a").loadingOlder).toBe(true);
      if (!live) throw new Error("Live subscription missing");
      const incoming = message(author, "a", "**incoming**", 30);
      live.receive(
        scenario === "traffic"
          ? [incoming]
          : [roster(relay, "a", [], 1_800_000_000)],
      );
      worker().reply();
      await vi.advanceTimersByTimeAsync(0);
      expect(q.window("a").rows.map((row) => row.id)).toEqual(
        scenario === "traffic" ? [older.id, head.id, incoming.id] : [],
      );
      if (scenario === "revocation")
        expect(preparedMarkdown("**older**")).toBeUndefined();
    } finally {
      session.dispose();
    }
  },
);
