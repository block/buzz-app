import { afterEach, expect, it, vi } from "vitest";
import type { ClientSnapshot } from "../communities/service";
import {
  bindDeepLinks,
  createDeepLinkShell,
  deepLinkStep,
  type DeepLinkShell,
} from "./deep-links";
import { targetLink, type OpenTarget } from "./targets";

const native = vi.hoisted(() => ({ value: false }));
const invoked = vi.hoisted(() => ({
  fn: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => []),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: (command: string, args?: unknown) => invoked.fn(command, args),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
afterEach(() => {
  native.value = false;
  invoked.fn.mockReset();
  invoked.fn.mockImplementation(async () => []);
  vi.restoreAllMocks();
});

const viewer = "a".repeat(64);
const origin = "https://deep-link.example";
const elsewhere = "https://elsewhere.example";
const message =
  "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
const root = "b".repeat(64);
const client = { viewer, selected: origin };
const messageLink = `buzz://message?channel=general&id=${message}&thread=${root}`;
// What Copy link produces: this app's own in-app locator, which is not a Buzz link.
const copied = targetLink({
  version: 1,
  kind: "conversation",
  scope: { viewer: "c".repeat(64), communityOrigin: elsewhere },
  channelId: "general",
  messageId: message,
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("binds message and channel links to the selected community and viewer", () => {
  expect(deepLinkStep(messageLink, client)).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
      threadRootId: root,
    },
  });
  expect(deepLinkStep("buzz://channel/general", client)).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
    },
  });
  expect(
    deepLinkStep(
      `buzz://message?channel=general&id=${message.toUpperCase()}`,
      client,
    ),
  ).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
    },
  });
});
it("fails as unavailable without a selected community or identity, never inventing one", () => {
  expect(
    deepLinkStep("buzz://channel/general", { viewer, selected: null }),
  ).toEqual({ fail: "unavailable" });
  expect(deepLinkStep(messageLink, { selected: origin })).toEqual({
    fail: "unavailable",
  });
});
it.each([
  // `buzz://open?target=…` is not a Buzz link, however well-formed: neither what
  // Copy link produces nor an unscoped locator opens from the OS.
  copied,
  targetLink({ version: 1, kind: "home" }),
  targetLink({ version: 1, kind: "settings", section: "appearance" }),
  targetLink({
    version: 1,
    kind: "page",
    pluginId: "buzz.projects",
    pageId: "projects",
    scope: null,
  }),
  "buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22home%22%7D&extra=1",
  `buzz://open?target=${"x".repeat(40_000)}`,
  "buzz://join?relay=example&code=abc123",
  "buzz://join?relay=example",
  "buzz://pr?id=1&owner=alice&d=repo",
  "buzz://issue?id=1&owner=alice&d=repo",
  "buzz://connect?relay=example",
  "buzz://add-community?relay=example",
  "buzz://unknown/general",
  `buzz:agent-activity?agent=${"a".repeat(64)}`,
  // Only the exact buzz scheme: no other case, prefix, suffix or padding.
  "BUZZ://channel/general",
  `Buzz://message?channel=general&id=${message}`,
  "buzz-app://channel/general",
  "buzz-dev-3fa9c1://channel/general",
  "xbuzz://channel/general",
  " buzz://channel/general",
  "buzz",
  "buzz://user@channel/general",
  "buzz://channel:443/general",
  "buzz://channel/general?relay=evil",
  `${messageLink}#fragment`,
  `${messageLink}&viewer=${"b".repeat(64)}`,
  "buzz://message?channel=general&id=bad",
  "https://example.com/?next=buzz://channel/general",
  "javascript:alert(1)",
  "",
  "not a url",
  `buzz://channel/${"g".repeat(40_000)}`,
])(
  "fails an unsupported or unparseable OS link as invalid-target instead of dropping it: %s",
  (url) => {
    expect(deepLinkStep(url, client)).toEqual({ fail: "invalid-target" });
  },
);
it("rejects non-string shell payloads the same way", () => {
  expect(deepLinkStep(42 as unknown as string, client)).toEqual({
    fail: "invalid-target",
  });
});

type Client = Pick<ClientSnapshot, "status" | "viewer" | "selected">;
function harness(initial: Client, pending: string[] = []) {
  const queue = [...pending];
  const watchers = new Set<() => void>();
  const take = vi.fn(async (): Promise<readonly string[]> => queue.splice(0));
  const shell: DeepLinkShell = {
    take,
    watch(listener) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  };
  let client = initial;
  const clientListeners = new Set<() => void>();
  const log: string[] = [];
  const host = {
    navigation: {
      open: vi.fn(async (target: OpenTarget) => {
        log.push(`open:${JSON.stringify(target)}`);
        return { status: "opened" as const };
      }),
    },
    fail: vi.fn((reason: string) => {
      log.push(`fail:${reason}`);
    }),
  };
  const stop = bindDeepLinks(
    host,
    {
      snapshot: () => client,
      subscribe(fn) {
        clientListeners.add(fn);
        return () => {
          clientListeners.delete(fn);
        };
      },
    },
    shell,
  );
  return {
    host,
    take,
    log,
    stop,
    watchers,
    arrive(...urls: unknown[]) {
      queue.push(...(urls as string[]));
      for (const fn of watchers) fn();
    },
    become(next: Partial<Client>) {
      client = { ...client, ...next };
      for (const fn of clientListeners) fn();
    },
  };
}
const ready: Client = { status: "ready", viewer, selected: origin };
const loading: Client = { status: "loading", selected: null };
const channelOpen = `open:${JSON.stringify({
  version: 1,
  kind: "conversation",
  scope: { viewer, communityOrigin: origin },
  channelId: "general",
})}`;

it("drains the shell at startup and opens a held link only once the client is ready", async () => {
  const t = harness(loading, ["buzz://channel/general"]);
  await settle();
  expect(t.take).toHaveBeenCalledTimes(1);
  expect(t.log).toEqual([]);
  t.become({ status: "ready", viewer, selected: origin });
  expect(t.log).toEqual([channelOpen]);
  t.stop();
});
it("waits for loading to finish even for links that will fail, then reports them in arrival order", async () => {
  const t = harness(loading, ["buzz://join?relay=example"]);
  await settle();
  expect(t.host.fail).not.toHaveBeenCalled();
  t.become({ status: "unavailable" });
  expect(t.log).toEqual(["fail:invalid-target"]);
  t.stop();
});
it("opens later arrivals in order and surfaces unsupported ones through the host", async () => {
  const t = harness(ready);
  await settle();
  t.arrive("buzz://channel/general", copied, messageLink);
  await settle();
  expect(t.log).toEqual([
    channelOpen,
    "fail:invalid-target",
    `open:${JSON.stringify({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
      threadRootId: root,
    })}`,
  ]);
  t.stop();
});
it("fails a message link as unavailable when the ready client has no selected community", async () => {
  const t = harness({ status: "ready", viewer, selected: null });
  await settle();
  t.arrive(messageLink);
  await settle();
  expect(t.log).toEqual(["fail:unavailable"]);
  t.become({ selected: origin });
  // Nothing is retained for automatic retry in this slice.
  expect(t.log).toEqual(["fail:unavailable"]);
  t.stop();
});
it("ignores non-string shell entries and keeps going", async () => {
  const t = harness(ready);
  await settle();
  t.arrive(42, null, "buzz://channel/general");
  await settle();
  expect(t.log).toEqual([channelOpen]);
  t.stop();
});
it("reports a failing shell read without throwing or navigating", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = harness(ready);
  t.take.mockRejectedValueOnce(new Error("no shell"));
  t.arrive("buzz://channel/general");
  await settle();
  expect(error).toHaveBeenCalledWith(
    "Could not read pending deep links",
    expect.any(Error),
  );
  expect(t.log).toEqual([channelOpen]);
  t.stop();
});
it("still drains once when the shell cannot deliver updates, without aborting startup", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = { navigation: { open: vi.fn() }, fail: vi.fn() };
  const stop = bindDeepLinks(
    host,
    { snapshot: () => ready, subscribe: () => () => {} },
    {
      take: async () => ["buzz://join?relay=example"],
      watch() {
        throw new Error("no channel");
      },
    },
  );
  await settle();
  expect(error).toHaveBeenCalledWith(
    "Deep link updates are unavailable",
    expect.any(Error),
  );
  expect(host.fail).toHaveBeenCalledWith("invalid-target");
  stop();
});
it("stops draining and reacting after disposal", async () => {
  const t = harness(loading, ["buzz://channel/general"]);
  await settle();
  t.stop();
  expect(t.watchers.size).toBe(0);
  t.become({ status: "ready", viewer, selected: origin });
  t.arrive("buzz://channel/general");
  await settle();
  expect(t.take).toHaveBeenCalledTimes(1);
  expect(t.log).toEqual([]);
});
it("is a no-op in the browser build, where no shell exists", async () => {
  expect(createDeepLinkShell()).toBeUndefined();
  const host = { navigation: { open: vi.fn() }, fail: vi.fn() };
  const subscribe = vi.fn(() => () => {});
  const stop = bindDeepLinks(host, {
    snapshot: () => ready,
    subscribe,
  });
  await settle();
  expect(subscribe).not.toHaveBeenCalled();
  expect(invoked.fn).not.toHaveBeenCalled();
  stop();
});
it("bridges the Tauri shell with raw strings only and detaches its ping channel on stop", async () => {
  native.value = true;
  let channel: { onmessage: (response: unknown) => void } | undefined;
  invoked.fn.mockImplementation(async (command, args) => {
    // The bridge does not interpret what it carries; the scheme is irrelevant here.
    if (command === "deep_link_take")
      return ["buzz://channel/general", 7, null];
    if (command === "deep_link_watch") {
      channel = (args as { onEvent: typeof channel }).onEvent;
      return undefined;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const shell = createDeepLinkShell();
  expect(shell).toBeDefined();
  await expect(shell?.take()).resolves.toEqual(["buzz://channel/general"]);
  const listener = vi.fn();
  const stop = shell?.watch(listener) ?? (() => {});
  await settle();
  expect(invoked.fn).toHaveBeenCalledWith("deep_link_watch", {
    onEvent: channel,
  });
  channel?.onmessage({ pending: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  channel?.onmessage({ pending: 2 });
  expect(listener).toHaveBeenCalledTimes(1);
});
