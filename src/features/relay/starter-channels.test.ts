// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readView } from "../../shared/view-state";
import type { ChannelSummary } from "./contracts";
import type { RelaySession } from "./session";
import { ensureStarterChannels } from "./starter-channels";

const scope = `https://example.test:${"ab".repeat(32)}`;
const marker = () => readView<boolean>(scope, "starter-channels-done", false);
const stream = (name: string, extra: Partial<ChannelSummary> = {}) =>
  ({
    id: `id-${name.toLowerCase()}`,
    name,
    channelType: "stream",
    visibility: "public",
    ...extra,
  }) as ChannelSummary;

/** The relay's unjoined public channels, found by exact name like the store. */
function session(
  directory: readonly ChannelSummary[],
  run: (action: string, id: string) => Promise<void> = async () => {},
  status: "loading" | "ready" = "ready",
) {
  const listeners = new Set<() => void>();
  const state = { status };
  const searchPublic = vi.fn(async (query: string) => ({
    channels: directory.filter(
      (channel) => channel.name.toLowerCase() === query,
    ),
    partial: false,
  }));
  const join = vi.fn(
    (
      action: string,
      id: string,
      _signal?: AbortSignal,
      _active?: () => boolean,
      _options?: object,
    ) => run(action, id),
  );
  const fake = {
    channels: {
      list: () => ({ status: state.status, channels: [] }),
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      searchPublic,
    },
    channelLifecycle: { available: true, run: join },
  } as unknown as Pick<RelaySession, "channels" | "channelLifecycle">;
  return {
    fake,
    join,
    searchPublic,
    ready() {
      state.status = "ready";
      for (const listener of listeners) listener();
    },
    listeners,
  };
}
const joined = (join: ReturnType<typeof session>["join"]) =>
  join.mock.calls.map(([, id]) => id);

afterEach(() => localStorage.clear());

describe("ensureStarterChannels", () => {
  it("joins existing starters one at a time and leaves other channels alone", async () => {
    let open = 0;
    let overlap = 0;
    const { fake, join } = session(
      [
        stream("random"),
        stream("general"),
        stream("welcome-everyone"),
        stream("announcements", { joinRole: "guest" }),
      ],
      async () => {
        overlap = Math.max(overlap, ++open);
        await new Promise((resolve) => setTimeout(resolve, 0));
        open--;
      },
    );
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    expect(joined(join)).toEqual([
      "id-general",
      "id-welcome-everyone",
      "id-announcements",
    ]);
    // A bare join: the lifecycle owner takes the channel's own join role.
    expect(join.mock.calls.every(([action]) => action === "join")).toBe(true);
    expect(overlap).toBe(1);
    expect(marker()).toBe(true);
  });

  it("never creates a channel and skips a starter the community lacks", async () => {
    const { fake, join } = session([stream("random"), stream("general")]);
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    expect(joined(join)).toEqual(["id-general"]);
    // Missing starters are not a failure, so the pass is complete.
    expect(marker()).toBe(true);
  });

  it("leaves no marker after a partial lookup, but joins what it found", async () => {
    const first = session([stream("general"), stream("announcements")]);
    first.searchPublic.mockImplementation(async (query: string) => ({
      channels: query === "welcome-everyone" ? [] : [stream(query)],
      partial: query === "welcome-everyone",
    }));
    await ensureStarterChannels(
      first.fake,
      scope,
      new AbortController().signal,
    );
    expect(joined(first.join)).toEqual(["id-general", "id-announcements"]);
    expect(marker()).toBe(false);
    // A missing starter is absent only when the whole directory was read.
    const second = session([stream("welcome-everyone")]);
    await ensureStarterChannels(
      second.fake,
      scope,
      new AbortController().signal,
    );
    expect(second.searchPublic).toHaveBeenCalledWith(
      "welcome-everyone",
      expect.anything(),
    );
    expect(joined(second.join)).toEqual(["id-welcome-everyone"]);
    expect(marker()).toBe(true);
  });

  it("joins in the background so a viewer's own action wins", async () => {
    const { fake, join } = session([stream("general")]);
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    expect(join.mock.calls[0]?.[4]).toEqual({ background: true });
  });

  it("does nothing once the marker is set", async () => {
    const first = session([stream("general")]);
    await ensureStarterChannels(
      first.fake,
      scope,
      new AbortController().signal,
    );
    const second = session([stream("general"), stream("announcements")]);
    await ensureStarterChannels(
      second.fake,
      scope,
      new AbortController().signal,
    );
    expect(second.searchPublic).not.toHaveBeenCalled();
    expect(second.join).not.toHaveBeenCalled();
  });

  it("keeps the marker per viewer and community", async () => {
    const { fake } = session([stream("general")]);
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    const other = session([stream("general")]);
    await ensureStarterChannels(
      other.fake,
      `https://other.test:${"ab".repeat(32)}`,
      new AbortController().signal,
    );
    expect(other.join).toHaveBeenCalledTimes(1);
  });

  it("leaves no marker after a failed join, so the next session retries", async () => {
    const failing = session(
      [stream("general"), stream("announcements")],
      async (_, id) => {
        if (id === "id-general") throw new Error("relay rejected the join");
      },
    );
    await ensureStarterChannels(
      failing.fake,
      scope,
      new AbortController().signal,
    );
    // One failure does not stop the others.
    expect(joined(failing.join)).toEqual(["id-general", "id-announcements"]);
    expect(marker()).toBe(false);
    const retry = session([stream("general"), stream("announcements")]);
    await ensureStarterChannels(
      retry.fake,
      scope,
      new AbortController().signal,
    );
    expect(retry.join).toHaveBeenCalledTimes(2);
    expect(marker()).toBe(true);
  });

  it("matches names case-insensitively", async () => {
    const { fake, join } = session([stream("Announcements")]);
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    expect(joined(join)).toEqual(["id-announcements"]);
  });

  it("joins only active public streams", async () => {
    const { fake, join } = session([
      stream("general", { channelType: "forum" }),
      stream("welcome-everyone", { archived: true }),
      stream("announcements"),
    ]);
    await ensureStarterChannels(fake, scope, new AbortController().signal);
    expect(joined(join)).toEqual(["id-announcements"]);
  });

  it("skips sessions that cannot write", async () => {
    const { fake, searchPublic } = session([stream("general")]);
    await ensureStarterChannels(
      {
        channels: fake.channels,
        channelLifecycle: { ...fake.channelLifecycle, available: false },
      },
      scope,
      new AbortController().signal,
    );
    expect(searchPublic).not.toHaveBeenCalled();
    expect(marker()).toBe(false);
  });

  it("waits for the channel list", async () => {
    const waiting = session([stream("general")], undefined, "loading");
    const done = ensureStarterChannels(
      waiting.fake,
      scope,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(waiting.searchPublic).not.toHaveBeenCalled();
    waiting.ready();
    await done;
    expect(waiting.join).toHaveBeenCalledTimes(1);
    expect(waiting.listeners.size).toBe(0);
  });

  it("stops with the session without a marker", async () => {
    const closed = new AbortController();
    const stopped = session([stream("general")], undefined, "loading");
    const pending = ensureStarterChannels(stopped.fake, scope, closed.signal);
    closed.abort();
    await pending;
    expect(stopped.listeners.size).toBe(0);
    expect(stopped.join).not.toHaveBeenCalled();
    expect(marker()).toBe(false);
  });
});
