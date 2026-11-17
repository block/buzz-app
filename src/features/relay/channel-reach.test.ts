import { describe, expect, it, vi } from "vitest";
import type { ChannelAccess, ChannelAccessAnswer } from "./channel-access";
import { type ChannelReachHost, createChannelReach } from "./channel-reach";
import { ReadError } from "./errors";

const id = "00000000-0000-8000-8000-00000000000a";

/** A host whose access check is the session's: grants, denials and
 * suspensions decide what `current` reports. */
function setup(options: { access?: boolean } = {}) {
  const grants = new Map<string, ChannelAccess>();
  const denied = new Set<string>();
  const suspended = new Set<string>();
  const previews = new Set<string>();
  const members = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let answers: Array<() => Promise<ChannelAccessAnswer>> = [];
  const lifetime = new AbortController();
  const host: ChannelReachHost & { asked: number; forgotten: string[] } = {
    asked: 0,
    forgotten: [],
    ...(options.access === false
      ? {}
      : {
          access: vi.fn(async (_ids: readonly string[]) => {
            host.asked++;
            const next = answers.shift();
            if (!next) throw new Error("No answer queued");
            return next();
          }),
        }),
    resolve: vi.fn(async () => {}),
    preview: (channel) => previews.has(channel),
    member: (channel) => members.has(channel),
    grant(channel, access) {
      grants.set(channel, access);
      denied.delete(channel);
      suspended.delete(channel);
      changed();
    },
    deny(channel) {
      grants.delete(channel);
      denied.add(channel);
      changed();
    },
    suspend(ids) {
      for (const channel of ids) suspended.add(channel);
      changed();
    },
    forget(channel) {
      grants.delete(channel);
      host.forgotten.push(channel);
      changed();
    },
    current(channel) {
      const grant = grants.get(channel);
      if (suspended.has(channel) || denied.has(channel)) return;
      if (grant) return { post: grant.post, joined: grant.joined };
      if (members.has(channel)) return { post: true, joined: true };
      return;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signal: lifetime.signal,
  };
  const answer = (access?: ChannelAccess) => () =>
    Promise.resolve(
      new Map(access ? [[id, access]] : []) as ChannelAccessAnswer,
    );
  const queue = (...next: Array<() => Promise<ChannelAccessAnswer>>) => {
    answers = [...answers, ...next];
  };
  return {
    host,
    reach: createChannelReach(host),
    answer,
    queue,
    previews,
    members,
    denied,
    suspended,
    grants,
    lifetime,
  };
}
const member: ChannelAccess = { post: true, joined: false, role: "member" };
const guest: ChannelAccess = { post: false, joined: false, role: "guest" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reaching a conversation", () => {
  it("waits for the relay's answer before offering reading or posting", async () => {
    const t = setup();
    let release!: (answer: ChannelAccessAnswer) => void;
    t.queue(
      () =>
        new Promise<ChannelAccessAnswer>((resolve) => {
          release = resolve;
        }),
    );
    const handle = t.reach.reach(id);
    expect(handle.snapshot()).toEqual({ status: "loading" });
    release(new Map([[id, member]]));
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "open",
      post: true,
      joined: false,
    });
  });

  it("opens a view-only person read-only, without a refused post first", async () => {
    const t = setup();
    t.queue(t.answer(guest));
    const handle = t.reach.reach(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "open",
      post: false,
      joined: false,
    });
  });

  it("is unavailable when the relay's complete answer leaves it out", async () => {
    const t = setup();
    t.queue(t.answer());
    const handle = t.reach.reach(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(t.denied.has(id)).toBe(true);
    expect(t.reach.holds(id)).toBe(false);
  });

  it("keeps couldn't-check apart from denial, and lets it retry", async () => {
    const t = setup();
    t.queue(
      () => Promise.reject(new ReadError("unavailable", "down", 503)),
      t.answer(member),
    );
    const handle = t.reach.reach(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    expect(t.denied.has(id)).toBe(false);
    expect(t.reach.holds(id)).toBe(true);
    handle.retry();
    await settle();
    expect(handle.snapshot()).toMatchObject({ status: "open", post: true });
  });

  it("hides an open conversation while a failed recheck is uncertain, and never revokes it", async () => {
    const t = setup();
    t.queue(
      t.answer(member),
      () => Promise.reject(new TypeError("Failed to fetch")),
      t.answer(member),
    );
    const handle = t.reach.reach(id);
    await settle();
    t.reach.recheck([id]);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    expect(t.suspended.has(id)).toBe(true);
    expect(t.denied.has(id)).toBe(false);
    t.reach.recheck();
    await settle();
    expect(handle.snapshot()).toMatchObject({ status: "open", post: true });
    expect(t.suspended.has(id)).toBe(false);
  });

  it("loses and regains posting while reading continues", async () => {
    const t = setup();
    t.queue(t.answer(member), t.answer(guest), t.answer(member));
    const handle = t.reach.reach(id);
    const seen: unknown[] = [];
    handle.subscribe(() => seen.push(handle.snapshot()));
    await settle();
    t.reach.recheck([id]);
    await settle();
    t.reach.recheck([id]);
    await settle();
    expect(seen).toEqual([
      { status: "open", post: true, joined: false },
      { status: "open", post: false, joined: false },
      { status: "open", post: true, joined: false },
    ]);
  });

  it("closes a conversation whose access the relay confirms is gone", async () => {
    const t = setup();
    t.queue(t.answer(member), t.answer());
    const handle = t.reach.reach(id);
    await settle();
    t.reach.recheck([id]);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
  });

  it("asks the relay again when access ends another way, showing nothing meanwhile", async () => {
    const t = setup();
    t.queue(t.answer(member), t.answer(member), t.answer());
    const handle = t.reach.reach(id);
    await settle();
    t.host.deny(id);
    expect(handle.snapshot()).toEqual({ status: "loading" });
    await settle();
    expect(handle.snapshot()).toMatchObject({ status: "open", post: true });
    t.host.deny(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(t.reach.holds(id)).toBe(false);
  });

  it("drops an answer that a newer access change overtook", async () => {
    const t = setup();
    let stale!: (answer: ChannelAccessAnswer) => void;
    t.queue(
      t.answer(member),
      () =>
        new Promise<ChannelAccessAnswer>((resolve) => {
          stale = resolve;
        }),
      t.answer(),
    );
    const handle = t.reach.reach(id);
    await settle();
    t.reach.recheck([id]);
    t.reach.suspend([id]);
    expect(handle.snapshot()).toEqual({ status: "loading" });
    stale(new Map([[id, member]]));
    await settle();
    await settle();
    expect(t.host.asked).toBe(3);
    expect(t.grants.has(id)).toBe(false);
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
  });

  it("asks once more when access changes during a check, and keeps the newest answer", async () => {
    const t = setup();
    let first!: (answer: ChannelAccessAnswer) => void;
    t.queue(
      () =>
        new Promise<ChannelAccessAnswer>((resolve) => {
          first = resolve;
        }),
      t.answer(),
    );
    const handle = t.reach.reach(id);
    t.reach.recheck([id]);
    first(new Map([[id, member]]));
    await settle();
    await settle();
    expect(t.host.asked).toBe(2);
    expect(handle.snapshot()).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
    });
  });

  it("keeps a conversation working for one view when another closes it", async () => {
    const t = setup();
    t.queue(t.answer(member));
    const first = t.reach.reach(id);
    const second = t.reach.reach(id);
    const heard = vi.fn();
    second.subscribe(heard);
    await settle();
    first.release();
    first.release();
    expect(t.host.forgotten).toEqual([]);
    expect(second.snapshot()).toMatchObject({ status: "open" });
    expect(heard).toHaveBeenCalled();
    second.release();
    expect(t.host.forgotten).toEqual([id]);
    expect(t.reach.holds(id)).toBe(false);
  });

  it("drops a check whose last view closed while it was pending", async () => {
    const t = setup();
    let resolve!: (answer: ChannelAccessAnswer) => void;
    t.queue(
      () =>
        new Promise<ChannelAccessAnswer>((done) => {
          resolve = done;
        }),
    );
    const handle = t.reach.reach(id);
    handle.release();
    resolve(new Map([[id, member]]));
    await settle();
    expect(t.grants.has(id)).toBe(false);
  });

  it("proves reading only, never posting, when the relay gives no answer", async () => {
    const t = setup({ access: false });
    t.previews.add(id);
    const handle = t.reach.reach(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "open",
      post: false,
      joined: false,
    });
  });

  it("grants nothing for an address alone", async () => {
    const t = setup({ access: false });
    const handle = t.reach.reach(id);
    await settle();
    expect(handle.snapshot()).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(t.grants.size).toBe(0);
  });
});
