// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { PullStates } from "./pull-states";
import { addConversationPullTools } from "./conversation-pull-tools";
import { approvedPull } from "./solo-pull.fixtures";
import { personalPull, savePersonalPull } from "./personal-pull";

const channel = "11111111-1111-4111-8111-111111111111";
const viewer = "c".repeat(64),
  key = "a".repeat(64);
const url = "https://github.com/example/project/pull/7";
const branch = "feature";
beforeEach(() => {
  let tail = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, _options: unknown, work: () => unknown) => {
        const next = tail.catch(() => {}).then(work);
        tail = next;
        return next;
      },
    },
  });
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture(type = "stream") {
  const tools = new Map<string, AddedTool>();
  const chat = {
    id: channel,
    creator: viewer,
    channelType: type,
    readOnly: true,
    archived: false,
  };
  const snapshotRead = vi.fn(async (filters) =>
    heads ? [{ ...heads, tags: [["d", filters[0]["#d"][0]]] }] : [],
  );
  let heads: object | undefined;
  const sign = vi.fn(async (event) => event);
  const publish = vi.fn(async () => "");
  const session = {
    viewer,
    scope: "https://example.org",
    snapshotRead,
    configArtifactWriter: { sign, publish },
    channels: { list: () => ({ channels: available ? [chat] : [] }) },
  } as unknown as RelaySession;
  let available = true,
    active = true,
    owner = viewer;
  const snapshot = { status: "ready", session, scope: session.scope };
  const relay = {
    snapshot: () => (active ? snapshot : { status: "disconnected" }),
  } as unknown as RelayData;
  const agents = {
    addTool: (tool: AddedTool) => tools.set(tool.name, tool),
    relay: () => relay,
    snapshot: () => ({ running: [{ key, pubkey: key, owner }] }),
  } as unknown as Agents;
  const state = { ...approvedPull().state, branch };
  const read = vi.fn(async () => ({ state, readAt: Date.now() }));
  const linked = vi.fn();
  addConversationPullTools(agents, { read } as unknown as PullStates, () => ({
    watch: () => () => {},
    get: () => undefined,
    linked,
  }));
  const controller = new AbortController();
  const client = { key, pubkey: key, signal: controller.signal } as BuzzClient;
  const call = (name: string, args: Record<string, unknown>) =>
    tools.get(name)?.call(client, { channel }, args);
  return {
    session,
    chat,
    read,
    state,
    sign,
    publish,
    snapshotRead,
    linked,
    controller,
    call,
    announce: () => call("github_announce_pr", { url, branch }),
    setHeads: (value: object) => {
      heads = value;
    },
    disconnect: () => {
      active = false;
    },
    revoke: () => {
      available = false;
    },
    foreign: () => {
      owner = "b".repeat(64);
    },
  };
}

it.each(["stream", "dm", "solo"])(
  "manually associates a personal PR in a read-only %s without any shared write",
  async (type) => {
    const f = fixture(type);
    await expect(f.call("github_link_pr", { url })).resolves.toContain(
      "device only",
    );
    expect(personalPull(f.session, channel)?.url).toBe(url);
    await f.call("github_link_pr", { unlink: true });
    expect(personalPull(f.session, channel)?.url).toBeNull();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.snapshotRead).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  },
);

it("verifies its own declared PR without sending, reading or mutating the read-only channel", async () => {
  const f = fixture();
  await expect(f.announce()).resolves.toContain("device only");
  expect(f.read).toHaveBeenCalledWith(url, { maxAge: 0, level: "details" });
  expect(personalPull(f.session, channel)?.source).toBe("announcement");
  await expect(f.announce()).resolves.toContain("Already associated");
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.snapshotRead).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it.each(["wrong-branch", "foreign-author", "public", "failed"])(
  "refuses automatic %s evidence",
  async (why) => {
    const f = fixture();
    if (why === "wrong-branch") f.state.branch = "other";
    if (why === "foreign-author")
      f.state.details = {
        ...f.state.details,
        checklist: { ...f.state.details.checklist, authored: false },
      };
    if (why === "public")
      f.state.details = { ...f.state.details, signedIn: false };
    if (why === "failed")
      f.read.mockRejectedValueOnce(new Error("GitHub failed"));
    await expect(f.announce()).rejects.toThrow();
    expect(personalPull(f.session, channel)).toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
  },
);

it.each(["replace", "unlink"])(
  "does no GitHub work when manual %s already wins",
  async (mode) => {
    const f = fixture();
    await savePersonalPull(f.session, channel, mode === "unlink" ? null : url);
    await expect(f.announce()).resolves.toContain("Kept");
    expect(f.read).not.toHaveBeenCalled();
  },
);

it.each([null, url])(
  "preserves an existing shared Solo link/tombstone before GitHub work: %s",
  async (saved) => {
    const f = fixture("solo");
    f.setHeads({ content: JSON.stringify({ url: saved }) });
    await expect(f.announce()).resolves.toContain(
      "saved Solo link or manual unlink",
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(personalPull(f.session, channel)).toBeUndefined();
  },
);

it("a manual unlink wins while an announcement verifies GitHub", async () => {
  const f = fixture();
  const read = deferred<Awaited<ReturnType<typeof f.read>>>();
  f.read.mockReturnValueOnce(read.promise);
  const automatic = f.announce();
  expect(f.read).toHaveBeenCalledOnce();
  await f.call("github_link_pr", { unlink: true });
  read.resolve({ state: f.state, readAt: Date.now() });
  await expect(automatic).resolves.toContain("Kept");
  expect(personalPull(f.session, channel)?.url).toBeNull();
});

it.each(["disconnect", "revoke", "foreign", "cancel"])(
  "revalidates %s after the GitHub read",
  async (change) => {
    const f = fixture();
    const read = deferred<Awaited<ReturnType<typeof f.read>>>();
    f.read.mockReturnValueOnce(read.promise);
    const result = f.announce();
    if (change === "cancel") f.controller.abort();
    else f[change as "disconnect" | "revoke" | "foreign"]();
    read.resolve({ state: f.state, readAt: Date.now() });
    await expect(result).rejects.toThrow();
    expect(personalPull(f.session, channel)).toBeUndefined();
  },
);

it.each(["stream", "dm", "solo"])(
  "keeps shared-write guards for a read-only %s",
  async (type) => {
    const f = fixture(type);
    await expect(
      f.call("github_link_pr", { url, shared: true }),
    ).rejects.toThrow("creator's writable Solo");
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  },
);

it.each([key, "b".repeat(64)])(
  "keeps agent-created/other-created shared Solos ineligible without blocking personal overlays",
  async (creator) => {
    const f = fixture("solo");
    f.chat.creator = creator;
    f.chat.readOnly = false;
    await expect(
      f.call("github_link_pr", { url, shared: true }),
    ).rejects.toThrow("creator's writable Solo");
    await expect(f.call("github_link_pr", { url })).resolves.toContain(
      "device only",
    );
    expect(f.sign).not.toHaveBeenCalled();
  },
);
