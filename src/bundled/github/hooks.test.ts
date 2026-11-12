// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  follow,
  followFromDevice,
  HOOK_TYPE,
  newSecret,
  parseHook,
  regenerate,
  repositoryOf,
  unfollow,
  webhookUrl,
  type Hook,
} from "./hooks";

const channel = "11111111-1111-4111-8111-111111111111";
const relay = "a".repeat(64);
const origin = "wss://relay.example.com";
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
      relayAuthor: relay,
      snapshotRead,
      configArtifactWriter: { sign, publish },
    } as unknown as RelaySession,
  };
}

const sealer = () =>
  vi.fn(async (_community: string, _relay: string, secret: string) => {
    return `sealed:${secret}`;
  });

const tags = (template: { tags: string[][] }, name: string) =>
  template.tags.filter((entry) => entry[0] === name).map((entry) => entry[1]);
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

it("names the webhook's URL on the community's own host", () => {
  expect(webhookUrl(origin, "abc")).toBe(
    "https://relay.example.com/hooks/github/abc",
  );
  expect(webhookUrl("ws://localhost:3000", "abc")).toBe(
    "https://localhost:3000/hooks/github/abc",
  );
});

it("makes a fresh 32 byte hex secret each time", () => {
  const a = newSecret();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(newSecret()).not.toBe(a);
});

it("follows a repository by creating a hook artifact whose secret only the relay can open", async () => {
  const { session: held, sign, publish } = session();
  const seal = sealer();
  const { d, secret } = await follow(held, origin, seal, channel, "block/buzz");
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(seal).toHaveBeenCalledWith(origin, relay, secret);
  const template = signed(sign);
  expect(template.kind).toBe(45010);
  expect(template.tags).toEqual([
    ["ar", "1"],
    ["d", d],
    ["h", channel],
    ["type", HOOK_TYPE],
    ["title", "block/buzz"],
    ["op", "create"],
    ["repo", "block/buzz"],
  ]);
  expect(JSON.parse(template.content)).toEqual({
    version: 1,
    repo: "block/buzz",
    secret: `sealed:${secret}`,
  });
  expect(template.content).not.toContain(`"${secret}"`);
  expect(publish).toHaveBeenCalledOnce();
});

it("follows from this device with no secret, naming the viewer as its publisher", async () => {
  const { session: held, sign, publish } = session();
  (held as { viewer?: string }).viewer = "c".repeat(64);
  const d = await followFromDevice(held, channel, "block/buzz");
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
  await expect(
    followFromDevice(anonymous.session, channel, "block/buzz"),
  ).rejects.toThrow("not known");
  expect(anonymous.sign).not.toHaveBeenCalled();
});

it("regenerates a hook's secret as an update on its head", async () => {
  const { session: held, sign } = session();
  const hook: Hook = {
    d: "hook-d",
    repo: "block/buzz",
    head,
    author: "c".repeat(64),
    createdAt: 1,
  };
  const secret = await regenerate(held, origin, sealer(), channel, hook);
  const template = signed(sign);
  expect(tags(template, "op")).toEqual(["update"]);
  expect(tags(template, "prev")).toEqual([head]);
  expect(tags(template, "d")).toEqual(["hook-d"]);
  expect(tags(template, "repo")).toEqual(["block/buzz"]);
  expect(JSON.parse(template.content)).toEqual({
    version: 1,
    repo: "block/buzz",
    secret: `sealed:${secret}`,
  });
});

it("unfollows with a delete revision that carries no title or content", async () => {
  const { session: held, sign } = session();
  await unfollow(held, channel, {
    d: "hook-d",
    repo: "block/buzz",
    head,
    author: "c".repeat(64),
    createdAt: 1,
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

it("saves nothing when the secret cannot be sealed, the relay is unknown, or the hook cannot be read", async () => {
  const sealed = session();
  const failing = vi.fn(async () => {
    throw new Error("no identity");
  });
  await expect(
    follow(sealed.session, origin, failing, channel, "block/buzz"),
  ).rejects.toThrow("no identity");
  expect(sealed.sign).not.toHaveBeenCalled();

  const unknown = session();
  (unknown.session as { relayAuthor?: string | undefined }).relayAuthor =
    undefined;
  await expect(
    follow(unknown.session, origin, sealer(), channel, "block/buzz"),
  ).rejects.toThrow("not known");
  expect(unknown.sign).not.toHaveBeenCalled();

  const unread = session();
  (
    unread.session.snapshotRead as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  await expect(
    unfollow(unread.session, channel, {
      d: "hook-d",
      repo: "x/y",
      head,
      author: "c".repeat(64),
      createdAt: 1,
    }),
  ).rejects.toThrow("could not be read");
  expect(unread.sign).not.toHaveBeenCalled();
});

it("tells the person when the community refuses or may not have saved a hook", async () => {
  const refused = session();
  refused.publish.mockRejectedValue(
    Object.assign(new Error("blocked: not a member"), {}),
  );
  await expect(
    follow(refused.session, origin, sealer(), channel, "block/buzz"),
  ).rejects.toThrow("may not have been saved");
});

it("lists a hook only from a well formed hook artifact", () => {
  const event = (extra: Partial<EventData> = {}): EventData => ({
    id: head,
    pubkey: "c".repeat(64),
    created_at: 1,
    kind: 45010,
    content: "{}",
    tags: [
      ["d", "hook-d"],
      ["h", channel],
      ["type", HOOK_TYPE],
      ["repo", "block/buzz"],
    ],
    ...extra,
  });
  expect(parseHook(event())).toEqual({
    d: "hook-d",
    repo: "block/buzz",
    head,
    author: "c".repeat(64),
    createdAt: 1,
  });
  expect(
    parseHook(
      event({
        pubkey: "c".repeat(64),
        tags: [...event().tags, ["publisher", "c".repeat(64)]],
      }),
    )?.publisher,
  ).toBe("c".repeat(64));
  expect(
    parseHook(event({ tags: [...event().tags, ["publisher", "9".repeat(64)]] }))
      ?.publisher,
  ).toBeUndefined();
  expect(parseHook(event({ kind: 9 }))).toBeUndefined();
  expect(
    parseHook(
      event({
        tags: [
          ["d", "hook-d"],
          ["type", "github.pull"],
          ["repo", "block/buzz"],
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
        ],
      }),
    ),
  ).toBeUndefined();
});
