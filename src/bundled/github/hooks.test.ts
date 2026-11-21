// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { follow, HOOK_TYPE, parseHook, repositoryOf, unfollow } from "./hooks";
import { canFollow } from "./index";

const channel = "11111111-1111-4111-8111-111111111111";
const viewer = "c".repeat(64);
const head = "e".repeat(64);

afterEach(() => vi.unstubAllGlobals());

function session() {
  const snapshotRead = vi.fn(async (_filters: unknown, _options?: unknown) => [
    {
      id: head,
      kind: 45010,
      tags: [
        ["d", "hook-d"],
        ["h", channel],
      ],
    },
  ]);
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: "c".repeat(64),
    sig: "",
  }));
  const publish = vi.fn(async () => "");
  return {
    sign,
    publish,
    session: {
      viewer,
      snapshotRead,
      configArtifactWriter: { sign, publish },
    } as unknown as RelaySession,
  };
}

const signed = (call: ReturnType<typeof session>["sign"]) =>
  call.mock.calls[0]?.[0] as unknown as {
    kind: number;
    content: string;
    tags: string[][];
  };

it("takes a repository as owner/repo or a github.com link, in lowercase", () => {
  expect(repositoryOf("Block/Buzz-App")).toBe("block/buzz-app");
  expect(repositoryOf(" https://github.com/block/buzz-app.git/ ")).toBe(
    "block/buzz-app",
  );
  expect(repositoryOf("https://github.com/block/buzz-app/pull/7")).toBe(
    undefined,
  );
  expect(repositoryOf("block")).toBe(undefined);
  expect(repositoryOf("a b/c")).toBe(undefined);
});

it("follows a repository with a hook artifact naming the viewer as its publisher", async () => {
  const { session: held, sign, publish } = session();
  const d = await follow(held, channel, "block/buzz");
  const template = signed(sign);
  expect(template.tags).toEqual([
    ["ar", "1"],
    ["d", d],
    ["h", channel],
    ["type", HOOK_TYPE],
    ["title", "block/buzz"],
    ["op", "create"],
    ["repo", "block/buzz"],
    ["publisher", "c".repeat(64)],
  ]);
  expect(JSON.parse(template.content)).toEqual({
    version: 1,
    repo: "block/buzz",
  });
  expect(publish).toHaveBeenCalledOnce();

  const anonymous = session();
  (anonymous.session as { viewer?: string | undefined }).viewer = undefined;
  await expect(
    follow(anonymous.session, channel, "block/buzz"),
  ).rejects.toThrow("not known");
  expect(anonymous.sign).not.toHaveBeenCalled();
});

it("unfollows with a delete revision that carries no title or content", async () => {
  const { session: held, sign } = session();
  await unfollow(held, channel, {
    d: "hook-d",
    repo: "block/buzz",
    head,
    author: viewer,
    createdAt: 1,
    publisher: viewer,
  });
  const template = signed(sign);
  expect(template.content).toBe("");
  expect(template.tags).toEqual([
    ["ar", "1"],
    ["d", "hook-d"],
    ["h", channel],
    ["type", HOOK_TYPE],
    ["op", "delete"],
    ["prev", head],
  ]);
});

it("unfollows nothing when the hook cannot be read", async () => {
  const unread = session();
  (
    unread.session.snapshotRead as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  await expect(
    unfollow(unread.session, channel, {
      d: "hook-d",
      repo: "x/y",
      head,
      author: viewer,
      createdAt: 1,
      publisher: viewer,
    }),
  ).rejects.toThrow("could not be read");
  expect(unread.sign).not.toHaveBeenCalled();
});

it("tells the person when the community refuses or may not have saved a hook", async () => {
  const refused = session();
  refused.publish.mockRejectedValue(
    Object.assign(new Error("blocked: not a member"), {}),
  );
  await expect(follow(refused.session, channel, "block/buzz")).rejects.toThrow(
    "may not have been saved",
  );
});

it("lists a hook only from a well formed hook artifact that names its author as publisher", () => {
  const event = (extra: Partial<EventData> = {}): EventData => ({
    id: head,
    pubkey: viewer,
    created_at: 1,
    kind: 45010,
    content: "{}",
    tags: [
      ["d", "hook-d"],
      ["h", channel],
      ["type", HOOK_TYPE],
      ["repo", "block/buzz"],
      ["publisher", viewer],
    ],
    ...extra,
  });
  expect(parseHook(event())).toEqual({
    d: "hook-d",
    repo: "block/buzz",
    head,
    author: viewer,
    createdAt: 1,
    publisher: viewer,
  });
  const without = event({
    tags: event().tags.filter((entry) => entry[0] !== "publisher"),
  });
  expect(parseHook(without)).toBeUndefined();
  expect(
    parseHook(
      event({ tags: [...without.tags, ["publisher", "9".repeat(64)]] }),
    ),
  ).toBeUndefined();
  expect(parseHook(event({ kind: 9 }))).toBeUndefined();
  expect(
    parseHook(
      event({
        tags: [
          ["d", "hook-d"],
          ["type", "github.pull"],
          ["repo", "block/buzz"],
          ["publisher", viewer],
        ],
      }),
    ),
  ).toBeUndefined();
  expect(
    parseHook(
      event({
        tags: [
          ["d", "hook-d"],
          ["type", HOOK_TYPE],
          ["repo", "Block/Buzz"],
          ["publisher", viewer],
        ],
      }),
    ),
  ).toBeUndefined();
});

it("offers following only to members who can post in a live stream or forum", () => {
  const writable = {
    viewer,
    configArtifactWriter: {},
  } as unknown as RelaySession;
  const summary = (extra: Partial<ChannelSummary> = {}) =>
    ({
      id: channel,
      name: "dev",
      channelType: "stream",
      members: [viewer],
      ...extra,
    }) as ChannelSummary;
  expect(canFollow(summary(), writable)).toBe(true);
  expect(canFollow(summary({ channelType: "forum" }), writable)).toBe(true);
  expect(
    canFollow(summary({ readOnly: true, viewerRole: "guest" }), writable),
  ).toBe(false);
  expect(canFollow(summary({ readOnly: true }), writable)).toBe(false);
  expect(canFollow(summary({ archived: true }), writable)).toBe(false);
  expect(canFollow(summary({ cached: true }), writable)).toBe(false);
  expect(canFollow(summary({ channelType: "dm" }), writable)).toBe(false);
  expect(canFollow(summary({ members: [] }), writable)).toBe(false);
  expect(canFollow(summary(), { viewer } as unknown as RelaySession)).toBe(
    false,
  );
});
