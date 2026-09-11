import { describe, expect, it } from "vitest";
import {
  bindSharedTarget,
  parseOpenTarget,
  parseSharedTarget,
  parseTargetLink,
  targetKey,
  targetLink,
  type OpenTarget,
} from "./targets";
const viewer = "a".repeat(64);
const conversation = {
  version: 1,
  kind: "conversation",
  scope: { viewer, communityOrigin: "wss://RELAY.example.:443/" },
  channelId: "channel-123",
  messageId: "B".repeat(64),
} as const;

describe("open target boundary", () => {
  it("canonicalizes and freezes a detached, bounded identity-scoped target", () => {
    const input = {
      ...conversation,
      scope: {
        ...conversation.scope,
        communityOrigin: String(conversation.scope.communityOrigin),
      },
    };
    const target = parseOpenTarget(input);
    input.scope.communityOrigin = "wss://other.example";
    expect(target).toEqual({
      ...conversation,
      scope: { viewer, communityOrigin: "https://relay.example" },
      messageId: "b".repeat(64),
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen("scope" in target && target.scope)).toBe(true);
  });
  it("separates copied locators from pinned activation targets", () => {
    const link = targetLink(conversation);
    expect(decodeURIComponent(link)).not.toContain(viewer);
    const shared = parseTargetLink(link);
    expect(shared).toEqual({
      ...parseOpenTarget(conversation),
      scope: { communityOrigin: "https://relay.example" },
    });
    expect(bindSharedTarget(shared, "c".repeat(64))).toEqual({
      ...parseOpenTarget(conversation),
      scope: {
        communityOrigin: "https://relay.example",
        viewer: "c".repeat(64),
      },
    });
    expect(() => parseOpenTarget(shared)).toThrow();
    expect(() => parseSharedTarget(conversation)).toThrow();
  });
  it("supports local targets without account or relay and gives routes stable identity", () => {
    for (const target of [
      { version: 1, kind: "home" },
      { version: 1, kind: "settings", section: "appearance" },
    ] as const)
      expect(bindSharedTarget(parseTargetLink(targetLink(target)), "")).toEqual(
        target,
      );
    const a: OpenTarget = {
      version: 1,
      kind: "page",
      pluginId: "org.example",
      pageId: "board",
      route: { version: 2, params: { b: 1, a: [true, null] } },
    };
    const b: OpenTarget = {
      ...a,
      route: { version: 2, params: { a: [true, null], b: 1 } },
    };
    expect(targetKey(a)).toBe(targetKey(b));
    expect(parseTargetLink(targetLink(a))).toEqual(a);
  });
  it.each([
    null,
    [],
    {},
    { version: 2, kind: "home" },
    { version: 1, kind: "home", command: "sign" },
    {
      ...conversation,
      scope: { viewer, communityOrigin: "https://secret@relay.example" },
    },
    {
      ...conversation,
      scope: { viewer, communityOrigin: "https://relay.example/path" },
    },
    {
      ...conversation,
      scope: { viewer: "npub1wrong", communityOrigin: "https://relay.example" },
    },
    { ...conversation, messageId: "not-an-id" },
    { ...conversation, messageId: undefined, threadRootId: "b".repeat(64) },
    { ...conversation, channelId: "../../other" },
    { version: 1, kind: "page", pluginId: "a/b", pageId: "board" },
    {
      version: 1,
      kind: "page",
      pluginId: "a",
      pageId: "board",
      route: { version: 0, params: null },
    },
  ])(
    "rejects malformed/unsupported targets without echoing input: %j",
    (input) => {
      expect(() => parseOpenTarget(input)).toThrow(
        "Invalid or unsupported navigation target",
      );
    },
  );
  it("bounds JSON bytes, depth, entries and non-JSON values; copies nested values", () => {
    const page = (params: unknown) => ({
      version: 1,
      kind: "page",
      pluginId: "a",
      pageId: "b",
      route: { version: 1, params },
    });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const params of [
      cycle,
      () => {},
      undefined,
      NaN,
      Infinity,
      new Date(),
      Array(257).fill(1),
      "🐭".repeat(3000),
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, 0])),
    ])
      expect(() => parseOpenTarget(page(params))).toThrow();
    const child = { y: "value" };
    const params = { x: [child] };
    const target = parseOpenTarget(page(params));
    child.y = "changed";
    expect(target.kind === "page" && target.route?.params).toEqual({
      x: [{ y: "value" }],
    });
    expect(() =>
      parseOpenTarget(
        page({
          get secret() {
            throw new Error("SECRET");
          },
        }),
      ),
    ).toThrow("Invalid or unsupported navigation target");
  });
  it.each([
    "https://open?target=%7B%7D",
    "javascript:alert(1)",
    "buzz://other",
    "buzz://open/path",
    "buzz://secret@open",
    "buzz://open?target={}&target={}",
    "buzz://open?target={}&x=1",
    "buzz://open?target={}",
    "buzz://open?target=%ZZ",
    `buzz://open?target=${"x".repeat(32769)}`,
  ])("rejects ambiguous/unsafe links", (link) =>
    expect(() => parseTargetLink(link)).toThrow(),
  );
});
it("copies dense arrays without calling caller map/iterator and rejects sparse/getter data", () => {
  const page = (params: unknown) => ({
    version: 1,
    kind: "page",
    pluginId: "a",
    pageId: "b",
    route: { version: 1, params },
  });
  const child = { value: "original" };
  const array = [child];
  Object.defineProperty(array, "map", { value: () => [child] });
  Object.defineProperty(array, Symbol.iterator, {
    value: () => {
      throw new Error("do not call");
    },
  });
  const parsed = parseOpenTarget(page(array));
  child.value = "mutated";
  expect(parsed.kind === "page" && parsed.route?.params).toEqual([
    { value: "original" },
  ]);
  expect(Object.isFrozen(parsed.kind === "page" && parsed.route?.params)).toBe(
    true,
  );
  expect(() => parseOpenTarget(page(Array(1)))).toThrow();
  let getterCalls = 0;
  expect(() =>
    parseOpenTarget({
      get version() {
        getterCalls++;
        return 1;
      },
      kind: "home",
    }),
  ).toThrow();
  expect(() =>
    parseOpenTarget(
      page({
        get value() {
          getterCalls++;
          return "no";
        },
      }),
    ),
  ).toThrow();
  const getterArray = [0];
  Object.defineProperty(getterArray, "0", {
    get() {
      getterCalls++;
      return 1;
    },
  });
  expect(() => parseOpenTarget(page(getterArray))).toThrow();
  expect(getterCalls).toBe(0);
});

it("keeps explicit Personal space distinct from an unspecified page scope in targets and links", () => {
  const page = {
    version: 1,
    kind: "page",
    pluginId: "a",
    pageId: "b",
  } as const;
  const personal = { ...page, scope: null };
  expect(parseOpenTarget(personal)).toEqual(personal);
  expect(targetKey(personal)).not.toBe(targetKey(page));
  expect(parseTargetLink(targetLink(personal))).toEqual(personal);
  expect(
    bindSharedTarget(parseTargetLink(targetLink(personal)), viewer),
  ).toEqual(personal);
  expect(() => parseOpenTarget({ ...conversation, scope: null })).toThrow();
});
