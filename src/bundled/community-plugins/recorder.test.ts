// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../../features/plugin-inventory/service";
import { INSTALL_TYPE, recordId, VOTE_TYPE } from "./community-counts";
import { createRecorder, RECORD_KEY, type Recorder } from "./recorder";
import { fakeCommunity, switchableRelay } from "./testing";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const channel = "00000001-0000-4000-8000-000000000000";
const notes: InstalledPlugin = {
  id: "octo.notes",
  source: {
    repository: "https://github.com/octo/notes",
    path: "",
    commit: "c".repeat(40),
  },
};
const board: InstalledPlugin = { id: "octo.board", source: "local" };

const recorders: Recorder[] = [];
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.stop();
  window.localStorage.clear();
});

function inventory(initial: InstalledPlugin[] | undefined) {
  let installed = initial;
  const listeners = new Set<() => void>();
  return {
    installed: () => installed,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: InstalledPlugin[]) {
      installed = next;
      for (const listener of listeners) listener();
    },
  };
}

function start(
  relay: Parameters<typeof createRecorder>[0]["relay"],
  plugins: ReturnType<typeof inventory>,
) {
  const recorder = createRecorder({ relay, inventory: plugins, delayMs: 1 });
  recorders.push(recorder);
  return recorder;
}

const on = (community: ReturnType<typeof fakeCommunity>, type = INSTALL_TYPE) =>
  community.store
    .heads()
    .filter(
      (event) =>
        event.pubkey === alice &&
        event.tags.some((t) => t[0] === "type" && t[1] === type) &&
        JSON.parse(event.content).on === true,
    )
    .map((event) => event.tags.find((t) => t[0] === "plugin")?.[1])
    .sort();

it("records what is installed at startup, creating the channel if none exists", async () => {
  const community = fakeCommunity();
  const recorder = start(community.relay, inventory([notes, board]));
  await recorder.sync();
  expect(community.create).toHaveBeenCalledTimes(1);
  expect(on(community)).toEqual(["octo.board", "octo.notes"]);
  const [record] = community.store
    .heads()
    .filter((event) => event.tags.some((t) => t[1] === "octo.notes"));
  expect(record?.tags).toEqual(
    expect.arrayContaining([
      ["installer", alice],
      ["source", "git"],
    ]),
  );
});

it("records installs and withdraws uninstalls as they happen", async () => {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: bob, createdAt: 1 }],
  });
  const plugins = inventory([notes]);
  const recorder = start(community.relay, plugins);
  const written = vi.fn();
  recorder.subscribe(written);
  await recorder.sync();
  expect(on(community)).toEqual(["octo.notes"]);
  plugins.set([notes, board]);
  await vi.waitFor(() =>
    expect(on(community)).toEqual(["octo.board", "octo.notes"]),
  );
  plugins.set([board]);
  await vi.waitFor(() => expect(on(community)).toEqual(["octo.board"]));
  expect(written).toHaveBeenCalledTimes(3);
  expect(community.create).not.toHaveBeenCalled();
});

it("withdraws an upvote along with its plugin's install", async () => {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: bob, createdAt: 1 }],
  });
  community.store.put({
    pubkey: alice,
    kind: 45010,
    created_at: 1,
    content: JSON.stringify({ version: 1, on: true }),
    tags: [
      ["d", await recordId(channel, VOTE_TYPE, alice, "octo.notes")],
      ["h", channel],
      ["type", VOTE_TYPE],
      ["plugin", "octo.notes"],
      ["installer", alice],
    ],
  });
  const recorder = start(community.relay, inventory([board]));
  await recorder.sync();
  expect(on(community, VOTE_TYPE)).toEqual([]);
  expect(on(community)).toEqual(["octo.board"]);
});

it("writes nothing when the records already match", async () => {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: bob, createdAt: 1 }],
  });
  const plugins = inventory([notes]);
  const first = start(community.relay, plugins);
  await first.sync();
  expect(community.publish).toHaveBeenCalledTimes(1);
  const reads = community.snapshotRead.mock.calls.length;
  plugins.set([notes]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(community.snapshotRead).toHaveBeenCalledTimes(reads);
  await first.sync();
  expect(community.publish).toHaveBeenCalledTimes(1);
  first.stop();
  await start(community.relay, inventory([notes])).sync();
  expect(community.publish).toHaveBeenCalledTimes(1);
});

it("keeps each signed-in community's records separately", async () => {
  const home = fakeCommunity();
  const work = fakeCommunity();
  const relay = switchableRelay(home);
  const plugins = inventory([notes]);
  const recorder = start(relay.relay, plugins);
  await recorder.sync();
  relay.select(work);
  await vi.waitFor(() => expect(on(work)).toEqual(["octo.notes"]));
  plugins.set([board]);
  await vi.waitFor(() => expect(on(work)).toEqual(["octo.board"]));
  expect(on(home)).toEqual(["octo.notes"]);
  relay.select(home);
  await vi.waitFor(() => expect(on(home)).toEqual(["octo.board"]));
  relay.select(undefined);
  await recorder.sync();
});

it("withdraws every record when recording is turned off, and restores them", async () => {
  const community = fakeCommunity();
  const recorder = start(community.relay, inventory([notes, board]));
  await recorder.sync();
  await recorder.setRecording(false);
  expect(JSON.parse(window.localStorage.getItem(RECORD_KEY) ?? "")).toEqual({
    [community.session.scope]: false,
  });
  expect(recorder.recording()).toBe(false);
  expect(on(community)).toEqual([]);
  const writes = community.publish.mock.calls.length;
  await recorder.sync();
  expect(community.publish).toHaveBeenCalledTimes(writes);
  await recorder.setRecording(true);
  expect(on(community)).toEqual(["octo.board", "octo.notes"]);
});

it("creates no channel while recording is off", async () => {
  const community = fakeCommunity();
  window.localStorage.setItem(
    RECORD_KEY,
    JSON.stringify({ [community.session.scope]: false }),
  );
  await start(community.relay, inventory([notes])).sync();
  expect(community.create).not.toHaveBeenCalled();
  expect(community.publish).not.toHaveBeenCalled();
});

it("stays quiet where the community can't keep records", async () => {
  const community = fakeCommunity();
  delete (community.session as unknown as { snapshotRead?: unknown })
    .snapshotRead;
  const recorder = start(community.relay, inventory([notes]));
  await expect(recorder.sync()).resolves.toBeUndefined();
  expect(community.create).not.toHaveBeenCalled();
  const pending = fakeCommunity();
  await start(pending.relay, inventory(undefined)).sync();
  expect(pending.findSystemLabeled).not.toHaveBeenCalled();
});

it("keeps each community's choice, so turning one on leaves another off", async () => {
  const home = fakeCommunity();
  const work = fakeCommunity();
  const relay = switchableRelay(home);
  const recorder = start(relay.relay, inventory([notes]));
  await recorder.sync();
  await recorder.setRecording(false);
  expect(on(home)).toEqual([]);
  relay.select(work);
  await recorder.setRecording(true);
  expect(on(work)).toEqual(["octo.notes"]);
  relay.select(home);
  expect(recorder.recording()).toBe(false);
  await recorder.sync();
  expect(on(home)).toEqual([]);
});

it("holds an opt-out the device couldn't save", async () => {
  const community = fakeCommunity();
  const plugins = inventory([notes]);
  const recorder = createRecorder({
    relay: community.relay,
    inventory: plugins,
    delayMs: 1,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
  });
  recorders.push(recorder);
  await recorder.sync();
  await recorder.setRecording(false);
  expect(recorder.recording()).toBe(false);
  expect(on(community)).toEqual([]);
  plugins.set([notes, board]);
  await recorder.sync();
  expect(on(community)).toEqual([]);
});

it("publishes nothing more from a pass that was running when recording turned off", async () => {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: bob, createdAt: 1 }],
  });
  let release = () => {};
  const lookup = community.findSystemLabeled.getMockImplementation();
  community.findSystemLabeled.mockImplementationOnce(async (label: string) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return (await lookup?.(label)) ?? [];
  });
  const recorder = start(community.relay, inventory([notes]));
  const pass = recorder.sync();
  await vi.waitFor(() =>
    expect(community.findSystemLabeled).toHaveBeenCalled(),
  );
  const off = recorder.setRecording(false);
  release();
  await Promise.all([pass.catch(() => {}), off]);
  await vi.waitFor(() => expect(recorder.recording()).toBe(false));
  expect(
    community.publish.mock.calls.some(
      ([event]) => JSON.parse(event.content).on === true,
    ),
  ).toBe(false);
});

it("reports a withdrawal that failed and retries it", async () => {
  const community = fakeCommunity();
  const recorder = createRecorder({
    relay: community.relay,
    inventory: inventory([notes]),
    delayMs: 1,
    retryMs: 5,
  });
  recorders.push(recorder);
  await recorder.sync();
  community.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(recorder.setRecording(false)).rejects.toThrow("offline");
  expect(on(community)).toEqual(["octo.notes"]);
  await vi.waitFor(() => expect(on(community)).toEqual([]));
});

it("waits for an upvote in flight before withdrawing, so it doesn't outlive the opt-out", async () => {
  const community = fakeCommunity();
  const recorder = start(community.relay, inventory([notes]));
  await recorder.sync();
  let release = () => {};
  const vote = recorder.write(async (session) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    const { writeRecord } = await import("./community-counts");
    const [found] = await community.findSystemLabeled("buzz-marketplace");
    await writeRecord(session, found?.id ?? "", VOTE_TYPE, "octo.notes", true);
    return true;
  });
  const off = recorder.setRecording(false);
  release();
  await Promise.all([vote, off]);
  expect(on(community, VOTE_TYPE)).toEqual([]);
  expect(on(community)).toEqual([]);
  await expect(recorder.write(async () => true)).resolves.toBeUndefined();
});

it("records in the channel the counts moved to, though nothing installed changed", async () => {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: bob, createdAt: 1 }],
  });
  const recorder = start(community.relay, inventory([notes]));
  await recorder.sync();
  community.made[0] = { ...community.made[0], archived: true } as never;
  const successor = "00000002-0000-4000-8000-000000000000";
  community.made.push({ id: successor, creator: bob, createdAt: 2 });
  recorder.sawChannel(successor);
  await vi.waitFor(() =>
    expect(
      community.store
        .heads()
        .some((event) =>
          event.tags.some((t) => t[0] === "h" && t[1] === successor),
        ),
    ).toBe(true),
  );
});
