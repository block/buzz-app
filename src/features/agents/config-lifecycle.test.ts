import { describe, expect, it, vi } from "vitest";
import { PublishRejected } from "../relay/outbox";
import {
  begin,
  LifecycleJournal,
  observe,
  resumeAll,
} from "./config-lifecycle";
import { gatedStore, memoryStorage, sharedFiles } from "./test-fakes";

const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const subject = "a".repeat(64);

function setup() {
  const storage = memoryStorage();
  const relay = { archived: false };
  const channels = {
    archive: vi.fn(async () => {
      relay.archived = true;
    }),
    unarchive: vi.fn(async () => {
      relay.archived = false;
    }),
    archived: vi.fn(async () => relay.archived),
  };
  const deps = {
    channels,
    journal: new LifecycleJournal(storage),
    community: "c",
  };
  return { deps, channels, relay, storage };
}

describe("archive and recover", () => {
  it("archives once strong metadata confirms it", async () => {
    const f = setup();
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archived");
  });

  it("persists the intent before the request, so starts block from then", async () => {
    const f = setup();
    f.channels.archive.mockImplementation(async () => {
      expect(f.deps.journal.get("c", subject)).toBe("archiving");
      expect(new LifecycleJournal(f.storage).get("c", subject)).toBe(
        "archiving",
      );
    });
    await begin(f.deps, subject, channel, "archive");
  });

  it("requests nothing until the intent is saved, and nothing when saving fails", async () => {
    const f = setup();
    const files = sharedFiles();
    let release = () => {};
    const journal = new LifecycleJournal(
      files.open(new Promise<void>((resolve) => (release = resolve))),
    );
    const archiving = begin(
      { ...f.deps, journal },
      subject,
      channel,
      "archive",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.channels.archive).not.toHaveBeenCalled();
    release();
    expect(await archiving).toBe("archived");
    expect(new LifecycleJournal(files.open()).get("c", subject)).toBe(
      "archived",
    );

    const failed = Promise.reject(new Error("disk full"));
    failed.catch(() => {});
    const refusing = new LifecycleJournal(sharedFiles().open(failed));
    await expect(
      begin({ ...f.deps, journal: refusing }, subject, channel, "recover"),
    ).rejects.toThrow("disk full");
    expect(f.channels.unarchive).not.toHaveBeenCalled();
    expect(refusing.get("c", subject)).toBe("active");
  });

  it("drives nothing on reconnect until a begun intent is saved", async () => {
    const f = setup();
    const disk = gatedStore();
    const deps = { ...f.deps, journal: new LifecycleJournal(disk.store) };
    const archiving = begin(deps, subject, channel, "archive");
    await vi.waitFor(() => expect(disk.writes).toHaveLength(1));
    // A reconnect retries pending intents while that one saves.
    const resumed = resumeAll(deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.channels.archive).not.toHaveBeenCalled();
    expect(new LifecycleJournal(disk.disk).get("c", subject)).toBe("active");
    disk.writes[0]?.land();
    await vi.waitFor(() => expect(disk.writes).toHaveLength(2));
    disk.writes[1]?.land();
    expect(await archiving).toBe("archived");
    await resumed;
  });

  it("archives when a confirmed recovery's save fails behind a newer archive", async () => {
    const f = setup();
    const disk = gatedStore();
    const journal = new LifecycleJournal(disk.store);
    const deps = { ...f.deps, journal };
    const saved = journal.put("c", subject, { state: "recovering", channel });
    await vi.waitFor(() => expect(disk.writes).toHaveLength(1));
    disk.writes[0]?.land();
    await saved;
    const recovered = observe(deps, subject, channel, false);
    const archiving = begin(deps, subject, channel, "archive");
    await vi.waitFor(() => expect(disk.writes).toHaveLength(2));
    disk.writes[1]?.fail();
    await expect(recovered).rejects.toThrow("disk full");
    await vi.waitFor(() => expect(disk.writes).toHaveLength(3));
    disk.writes[2]?.land();
    await vi.waitFor(() => expect(disk.writes).toHaveLength(4));
    disk.writes[3]?.land();
    expect(await archiving).toBe("archived");
    expect(f.channels.archive).toHaveBeenCalledOnce();
    expect(f.channels.unarchive).not.toHaveBeenCalled();
  });

  it("stays archiving after a lost reply and active metadata, then retries after restart", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(new Error("timeout"));
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
    const restarted = { ...f.deps, journal: new LifecycleJournal(f.storage) };
    await resumeAll(restarted);
    expect(restarted.journal.get("c", subject)).toBe("archived");
  });

  it("stays archiving when the metadata read fails, even after a refusal", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    f.channels.archived.mockRejectedValueOnce(new Error("offline"));
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
  });

  it("rolls back only on a definite refusal plus active metadata", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    expect(await begin(f.deps, subject, channel, "archive")).toBe("active");
  });

  it("never rolls back on a rate limit", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "rate-limited: slow down"),
    );
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
  });

  it("recovers to active on active metadata, and back to archived only on a refusal plus archived metadata", async () => {
    const f = setup();
    f.relay.archived = true;
    await f.deps.journal.put("c", subject, { state: "archived", channel });
    expect(await begin(f.deps, subject, channel, "recover")).toBe("active");
    f.relay.archived = true;
    f.channels.unarchive.mockRejectedValueOnce(new Error("timeout"));
    expect(await begin(f.deps, subject, channel, "recover")).toBe("recovering");
    f.channels.unarchive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: no"),
    );
    expect(await resumeAll(f.deps)).toEqual(["archived"]);
  });

  it("settles a pending archive from live discovery", async () => {
    const f = setup();
    await f.deps.journal.put("c", subject, { state: "archiving", channel });
    expect(await observe(f.deps, subject, channel, true)).toBe("archived");
  });

  it("never applies an archive's refusal to a recovery saved while its metadata was held", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    let answer = (_: boolean) => {};
    f.channels.archived.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const archiving = begin(f.deps, subject, channel, "archive");
    await vi.waitFor(() => expect(f.channels.archived).toHaveBeenCalled());
    await f.deps.journal.put("c", subject, { state: "recovering", channel });
    answer(true);
    expect(await archiving).toBe("recovering");
    expect(f.deps.journal.pending("c")).toEqual([
      { subject, state: "recovering", channel },
    ]);
    f.relay.archived = true;
    expect(await resumeAll(f.deps)).toEqual(["active"]);
    expect(f.channels.unarchive).toHaveBeenCalledOnce();
  });

  it("never applies an old request's answer to a newer one in the same state", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    let answer = (_: boolean) => {};
    f.channels.archived.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const first = begin(f.deps, subject, channel, "archive");
    await vi.waitFor(() => expect(f.channels.archived).toHaveBeenCalled());
    await f.deps.journal.put("c", subject, { state: "archiving", channel });
    answer(false);
    expect(await first).toBe("archiving");
  });
});
