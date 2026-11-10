// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalWork } from "../../features/agents/local-activity";
import type { RelaySession } from "../../features/relay/session";
import { workspaceCanvas } from "../../features/solo/workspace";
import type { Git } from "./git";
import { only, realGit, repo } from "./testing";
import { KEEP, TURNS_KEY, createTurns } from "./turns";

const canvases = new Map<string, string>();
vi.mock("../../features/agent-harness/project", () => ({
  ownerCanvas: async (_canvas: unknown, _owner: string, channelId: string) =>
    canvases.get(channelId),
}));

const storage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

function world(
  execution: Record<string, "local" | "remote"> = { A: "local", B: "local" },
) {
  const listeners = new Set<() => void>();
  let local: LocalWork[] = [];
  const session = {
    viewer: "me",
    canvas: {},
    agentChoices: {
      snapshot: () => ({
        identities: Object.entries(execution).map(([pubkey, mode]) => ({
          pubkey,
          execution: mode,
        })),
      }),
    },
    agentActivity: {
      activate: () => () => {},
      snapshot: () => ({ local }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const real = realGit();
  let snapshots = 0;
  const git: Git = async (args, options) => {
    const out = await real(args, options);
    if (args.includes("write-tree")) snapshots++;
    return out;
  };
  return {
    session,
    git,
    snapshots: () => snapshots,
    set(agent: string, id: string, state: LocalWork["state"], channelId = "c") {
      local = [
        ...local.filter((row) => row.messageId !== id),
        {
          scope: "s",
          agent,
          channelId,
          messageId: id,
          threadRootId: "",
          state,
          startedAt: 1,
        },
      ];
      for (const listener of listeners) listener();
    },
  };
}

const NOW = () => Date.now();
const stored = (store: Storage): { id: string }[] =>
  JSON.parse(store.getItem(TURNS_KEY) ?? "[]");
afterEach(() => canvases.clear());

describe("createTurns", () => {
  it("records a local turn's changes and shows them on the agent's last reply", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    const stop = turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => expect(turns.version()).toBeGreaterThanOrEqual(2));
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    const turn = only(turns.cardsFor("m1"));
    expect(turn?.checkouts[0]?.files).toBe(2);
    const files = await turns.summary(turn.id, 0);
    expect(files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
    const patch = await turns.patch(turn.id, 0, only(files));
    expect(patch).toContain("+two");
    stop();
  });

  it("gives the card to the later of two replies in one turn", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    const first = NOW();
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: first,
    });
    turns.claim({
      id: "m2",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: first + 5,
    });
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => expect(turns.cardsFor("m2")).toHaveLength(1));
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("shows nothing for a turn that changed nothing", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("ignores an agent that runs remotely or on another machine", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world({ A: "remote" });
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    w.set("Elsewhere", "req2", "working");
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    w.set("Elsewhere", "req2", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("does nothing in a chat without project folders", async () => {
    const w = world();
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    w.set("A", "req", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
  });

  it("does not track work that was already going when it started", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    w.set("A", "req", "working");
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
  });

  it("marks a card whose checkout another local agent was changing too", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    canvases.set("d", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "r1", "working", "c");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    w.set("B", "r2", "working", "d");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "r1", "done", "c");
    w.set("B", "r2", "done", "d");
    await vi.waitFor(() => expect(w.snapshots()).toBe(4));
    await vi.waitFor(() => expect(turns.version()).toBeGreaterThanOrEqual(3));
    const at = NOW();
    turns.claim({
      id: "ma",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: at,
    });
    turns.claim({
      id: "mb",
      authorId: "B",
      channelId: "d",
      createdAt: 0,
      createdAtMs: at,
    });
    expect(turns.cardsFor("ma")[0]?.checkouts[0]?.shared).toBe(true);
    expect(turns.cardsFor("mb")[0]?.checkouts[0]?.shared).toBe(true);
  });

  it("shows another account's cards to no one else", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const store = storage();
    const mine = createTurns(w.git, store);
    mine.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => {
      mine.flush();
      expect(store.getItem(TURNS_KEY)).not.toBeNull();
    });
    const other = createTurns(w.git, store);
    other.watch(
      { ...w.session, viewer: "someone-else" } as RelaySession,
      "https://relay.example",
    );
    other.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(other.cardsFor("m1")).toEqual([]);
    const again = createTurns(w.git, store);
    again.watch(w.session, "https://relay.example");
    expect(again.find(only(stored(store)).id, 0)).toBeDefined();
  });

  it("keeps the latest turns in storage and ignores damaged records", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const old = Array.from({ length: KEEP + 20 }, (_, n) => ({
      id: `t${n}`,
      agent: "A",
      channelId: "c",
      viewer: "me",
      origin: "https://relay.example",
      start: n,
      end: n + 1,
      message: { id: `m${n}`, at: n },
      checkouts: [
        {
          dir,
          prefix: "",
          label: "x",
          before: "a".repeat(40),
          after: "b".repeat(40),
          files: 1,
        },
      ],
    }));
    const store = storage({
      [TURNS_KEY]: JSON.stringify([...old, { id: 5 }, null, "x"]),
    });
    const w = world();
    const turns = createTurns(w.git, store);
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => {
      turns.flush();
      expect(stored(store)).toHaveLength(KEEP);
    });
  });

  it("survives unreadable storage", () => {
    const w = world();
    expect(() =>
      createTurns(w.git, storage({ [TURNS_KEY]: "{" })),
    ).not.toThrow();
  });
});
