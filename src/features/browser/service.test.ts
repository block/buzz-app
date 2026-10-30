// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { createElement, StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PanelsService,
  type PanelProps,
  type PanelOpenRequest,
} from "../panels/service";
import type { RelayData } from "../relay/service";
import type { Agents } from "../agents/service";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserService } from "./service";
import type { BrowserPlatform } from "./platform";
import { apply as applyBrowserControl } from "../../../examples/plugins/browser-control/src/index";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

function platform(available: boolean): BrowserPlatform {
  return {
    available,
    attach: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(),
  };
}

it("exposes availability and a host View", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  expect(context.browser.available).toBe(true);
  expect(typeof context.browser.View).toBe("function");
});

it("exposes authorization primitives without host-owned UI or an opening workflow", () => {
  const context = new Context();
  contexts.push(context);
  const native = platform(true);
  native.control = {
    available: vi.fn(async () => true),
    execute: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
  };
  new BrowserService(context, native);
  expect(Object.keys(context.browser.control ?? {})).toEqual([
    "available",
    "eligible",
    "forRecipient",
    "revokeRecipient",
    "execute",
  ]);
});

async function openingFixture(applyPlugin = applyBrowserControl) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  const context = new Context();
  contexts.push(context);
  const subscribe = () => () => {};
  const channel = {
    id: "chat",
    channelType: "stream",
    members: ["agent"],
    archived: false,
  };
  const choices = {
    selectable: [{ pubkey: "agent", name: "Tester" }],
    complete: true,
    pending: false,
    archives: { status: "ready" },
  };
  const channelList = { channels: [channel] };
  const connection = {
    scope: "fixture:owner",
    viewer: "owner",
    status: "ready",
    cached: false,
    session: {
      channels: {
        list: () => channelList,
        subscribeList: subscribe,
        ensureList: vi.fn(),
      },
      agentChoices: {
        snapshot: () => choices,
        subscribe,
        retain: subscribe,
        ensure: vi.fn(),
      },
    },
  };
  const agent = {
    key: "membership",
    pubkey: "agent",
    place: "here",
    owner: "owner",
  };
  const agents = { running: [agent] };
  context.provide("relay", {
    snapshot: () => connection,
    subscribe,
  } as unknown as RelayData);
  context.provide("agents", {
    snapshot: () => agents,
    subscribe,
    relay: () => ({ snapshot: () => connection }),
  } as unknown as Agents);
  const native = platform(true);
  let counter = 0;
  const granted = new Set<string>();
  native.attach = vi.fn(async () => `session-${++counter}`);
  native.setBounds = vi.fn(async () => {});
  native.detach = vi.fn(async () => {});
  native.status = vi.fn(async (session) => ({
    url: "https://example.org/",
    title: "Example",
    loading: false,
    error: null,
    control_granted: granted.has(session),
    control_revision: 0,
  }));
  native.control = {
    available: vi.fn(async () => true),
    grant: vi.fn(async (session) => {
      granted.add(session);
      return { token: session, revision: 1 };
    }),
    revoke: vi.fn(async (session) => {
      granted.delete(session);
    }),
    execute: vi.fn(async () => ({ text: "Example page" })),
  };
  new BrowserService(context, native);
  context.provide("pluginStatus", { isActive: () => true, subscribe });
  context.provide("react", React);
  context.agents.addTool = vi.fn();
  const panels = new PanelsService(context);
  const plugin = context.plugin({
    apply: (pluginContext) =>
      applyPlugin(
        pluginContext.extend({
          pluginOwner: { id: "test.browser", revision: "one" },
        }),
      ),
  });
  await plugin.await();
  let lastProps!: PanelProps;
  let lastView!: ReturnType<typeof render>;
  const handleOpen = vi.fn((request: PanelOpenRequest) => {
    const panel = panels.resolve(request.target);
    if (!panel) return false;
    lastProps = {
      target: request.target,
      close: vi.fn(),
      context: {
        channelId: request.channelId,
        ...(request.rootId && { rootId: request.rootId }),
        open: () => true,
        canOpen: () => true,
      },
    };
    const View = panel.component;
    lastView = render(
      createElement(StrictMode, null, createElement(View, lastProps)),
    );
    return true;
  });
  const dispose = panels.handleOpenRequests(handleOpen);
  const browserControl = context.browser.control;
  if (!browserControl) throw new Error("Missing browser control");
  return {
    context,
    disable: () => plugin.dispose(),
    native,
    panels,
    connection,
    agent,
    channel,
    choices,
    agents,
    handleOpen,
    dispose,
    view: () => lastView,
    props: () => lastProps,
    open: async (url = "https://example.org/") => {
      const tool = vi.mocked(context.agents.addTool).mock.calls[0]?.[0];
      if (!tool) throw new Error("Missing plugin tool");
      return JSON.parse(
        (await tool.call(
          { key: "membership" } as never,
          { channel: "chat", root: "thread" },
          { action: "open", url },
        )) as string,
      );
    },
  };
}

it("opens a new browser and permits immediate interaction without a Share click, with takeover retained", async () => {
  const f = await openingFixture();
  await expect(f.open()).resolves.toEqual({
    opened: true,
    url: "https://example.org/",
  });
  expect(f.native.attach).toHaveBeenCalledTimes(1);
  expect(f.native.control?.grant).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByRole("button", { name: "Take control from Tester" }),
  ).toBeVisible();
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Example page" });
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "other" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  await userEvent.click(
    screen.getByRole("button", { name: "Take control from Tester" }),
  );
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  const props = f.props();
  f.view().unmount();
  const View = f.panels.resolve(props.target)?.component;
  if (!View) throw new Error("Missing browser panel");
  render(createElement(View, props));
  await screen.findByRole("button", { name: "Share with Tester" });
  expect(f.native.control?.grant).toHaveBeenCalledTimes(1);
});

it("makes a newly opened page the caller's browser instead of leaving ambiguous grants", async () => {
  const f = await openingFixture();
  await f.open();
  await f.open();
  expect(f.handleOpen).toHaveBeenCalledTimes(2);
  expect(f.handleOpen.mock.calls[0]?.[0].target).not.toBe(
    f.handleOpen.mock.calls[1]?.[0].target,
  );
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Example page" });
  expect(f.native.control?.execute).toHaveBeenLastCalledWith("session-2", {
    action: "observe",
  });
});

it("rejects remote agents, archived conversations and invalid URLs before opening a panel", async () => {
  const f = await openingFixture();
  f.agent.place = "elsewhere";
  await expect(f.open()).rejects.toThrow("cannot open");
  f.agent.place = "here";
  f.channel.archived = true;
  await expect(f.open()).rejects.toThrow("cannot open");
  f.channel.archived = false;
  await expect(f.open("file:///tmp/example")).rejects.toThrow();
  expect(f.handleOpen).not.toHaveBeenCalled();
  expect(f.native.attach).not.toHaveBeenCalled();
});

it("reports when the conversation has no visible host instead of granting access", async () => {
  const f = await openingFixture();
  f.dispose();
  await expect(f.open()).rejects.toThrow("Keep this conversation visible");
  expect(f.native.control?.grant).not.toHaveBeenCalled();
});

it("cancels an opening during a pending native grant and suppresses its late completion", async () => {
  const f = await openingFixture();
  let finish!: (grant: { token: string; revision: number }) => void;
  if (!f.native.control) throw new Error("Missing native control");
  vi.mocked(f.native.control.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const opening = f.open();
  const rejected = expect(opening).rejects.toThrow("cancelled");
  await screen.findByRole("button", { name: "Take control from Tester" });
  await waitFor(() => expect(f.native.control?.grant).toHaveBeenCalledTimes(1));
  await userEvent.click(
    screen.getByRole("button", { name: "Take control from Tester" }),
  );
  await rejected;
  await act(async () => {
    finish({ token: "late", revision: 1 });
  });
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  expect(
    screen.queryByRole("button", { name: "Take control from Tester" }),
  ).not.toBeInTheDocument();
});

it("opens a fresh page after takeover and close, without reclaiming the parked session", async () => {
  const f = await openingFixture();
  await f.open();
  await userEvent.click(
    await screen.findByRole("button", { name: "Take control from Tester" }),
  );
  await f.native.navigate("session-1", "https://example.org/owner-work");
  f.view().unmount();
  await f.open();
  expect(f.native.attach).toHaveBeenCalledTimes(2);
  expect(f.native.attach).toHaveBeenLastCalledWith(
    "https://example.org/",
    expect.anything(),
    "browser-control-preview",
  );
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Example page" });
  expect(f.native.control?.execute).toHaveBeenLastCalledWith("session-2", {
    action: "observe",
  });
});

it("rejects concurrent opens for the same caller until its first page is ready", async () => {
  const f = await openingFixture();
  if (!f.native.control) throw new Error("Missing native control");
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(f.native.control.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = f.open();
  await waitFor(() => expect(f.native.control?.grant).toHaveBeenCalledTimes(1));
  await expect(f.open()).rejects.toThrow("already opening");
  await act(async () => {
    finish({ token: "session-1", revision: 1 });
  });
  await first;
  expect(f.handleOpen).toHaveBeenCalledTimes(1);
});

it("expires a pending opening and revokes a native grant that completes after the deadline", async () => {
  const f = await openingFixture();
  if (!f.native.control) throw new Error("Missing native control");
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(f.native.control.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.useFakeTimers();
  const opening = f.open();
  const result = opening.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() =>
    expect(f.native.control?.grant).toHaveBeenCalledTimes(1),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(await result).toEqual(
    expect.objectContaining({
      message: expect.stringContaining("did not become ready"),
    }),
  );
  await act(async () => {
    finish({ token: "expired", revision: 1 });
  });
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  expect(f.native.control.revoke).toHaveBeenCalledWith("session-1");
});

it("preserves an explicit owner recipient choice while the agent-created page is loading", async () => {
  const f = await openingFixture();
  f.choices.selectable.push({ pubkey: "second", name: "Second" });
  f.agents.running.push({
    key: "second",
    pubkey: "second",
    place: "here",
    owner: "owner",
  });
  f.channel.members.push("second");
  let loading = true;
  f.native.status = vi.fn(async () => ({
    url: loading ? "https://example.org/" : "https://example.org/loaded",
    title: "Example",
    loading,
    error: null,
  }));
  const opening = f.open();
  const rejected = expect(opening).rejects.toThrow("manual sharing choice");
  await userEvent.click(
    await screen.findByRole("button", { name: "Share browser" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Second" }),
  );
  await rejected;
  await screen.findByRole("button", { name: "Take control from Second" });
  loading = false;
  await screen.findByDisplayValue("example.org/loaded");
  expect(f.native.control?.grant).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Take control from Second" }),
  ).toBeVisible();
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  await expect(
    f.context.browser.control?.execute(
      "second",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Example page" });
});

it("opens, observes and revokes through the installable plugin artifact", async () => {
  const artifact = "../../../examples/plugins/browser-control/plugin.js";
  const f = await openingFixture((await import(artifact)).apply);
  await f.open();
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Example page" });
  await userEvent.click(
    await screen.findByRole("button", { name: "Take control from Tester" }),
  );
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
});

it("cancels a pending opening when the plugin is disabled and revokes a late grant", async () => {
  const f = await openingFixture();
  let finish!: (grant: { token: string; revision: number }) => void;
  if (!f.native.control) throw new Error("Missing native control");
  vi.mocked(f.native.control.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const opening = f.open();
  const rejected = expect(opening).rejects.toThrow("plugin was disabled");
  await waitFor(() => expect(f.native.control?.grant).toHaveBeenCalled());
  await f.disable();
  await rejected;
  await act(async () => {
    finish({ token: "late", revision: 1 });
  });
  await waitFor(() =>
    expect(f.native.control?.revoke).toHaveBeenCalledWith("session-1"),
  );
  await expect(
    f.context.browser.control?.execute(
      "membership",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
});
