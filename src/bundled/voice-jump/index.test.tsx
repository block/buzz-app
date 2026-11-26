// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { ShortcutsService } from "../../features/shortcuts/service";
import type { ListenOptions } from "../../features/speech/service";
import type { PluginModule } from "../../plugins/api";
import { PluginRuntime } from "../../plugins/runtime";
import * as voiceJumpPlugin from "./index";

const viewer = "a".repeat(64);
const communityOrigin = "wss://relay.example.org";
const contexts: Context[] = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const channels = [
  { id: "design", name: "design", channelType: "stream", lastActivityAt: 2 },
  { id: "launch", name: "launch", channelType: "stream", lastActivityAt: 1 },
];
const session = {
  names: undefined,
  profiles: { snapshot: () => new Map() },
  channels: {
    list: () => ({ channels }),
    get: (id: string) => channels.find((channel) => channel.id === id),
    window: (channelId: string) => ({
      channelId,
      status: "ready",
      rows: [],
      hasMore: true,
      loadingOlder: false,
    }),
  },
  unread: { inbox: () => ({ items: [] }) },
};

const answer = (pick: string, probabilities: Record<string, number>) => ({
  outcome: "answered",
  backend: "test",
  model: "test",
  answers: {
    place: {
      type: "choice",
      choice: pick,
      confidence: probabilities[pick] ?? 0,
      probabilities,
    },
  },
});

const defaultPages: RegisteredPage[] = [
  {
    key: "buzz.reminders/reminders",
    pluginId: "buzz.reminders",
    revision: "bundled",
    id: "reminders",
    title: "Reminders",
    primary: true,
    component: () => null,
  },
  {
    key: "example.review-queue/queue",
    pluginId: "example.review-queue",
    revision: "1",
    id: "queue",
    title: "Review Queue",
    primary: true,
    component: () => null,
  },
];

async function mount({
  connected = true,
  pages = defaultPages,
}: {
  connected?: boolean;
  pages?: readonly RegisteredPage[];
} = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  const modules: Record<string, PluginModule> = {
    "buzz.voice-jump": voiceJumpPlugin,
  };
  const runtime = new PluginRuntime(ctx, async (plugin) => {
    const module = modules[plugin.manifest.id];
    if (!module) throw new Error(`No module for ${plugin.manifest.id}`);
    return module;
  });
  ctx.effect(() => () => runtime.dispose());
  const shortcuts = new ShortcutsService(ctx, window);
  let Overlay: ComponentType = () => null;
  let Toolbar: ComponentType = () => null;
  const listens: ListenOptions[] = [];
  const decide = vi.fn(async (_request: unknown) =>
    answer("#design", { "#design": 0.9, "#launch": 0.05 }),
  );
  const open = vi.fn(async () => ({ status: "opened" }));
  let relay: {
    status: string;
    session: typeof session;
    viewer: string | undefined;
    origin: string | undefined;
  } = connected
    ? { status: "ready", session, viewer, origin: communityOrigin }
    : { status: "idle", session, viewer: undefined, origin: undefined };
  const relayListeners = new Set<() => void>();
  const setRelay = (next: typeof relay) => {
    relay = next;
    for (const listener of relayListeners) listener();
  };
  ctx.provide("relay", {
    snapshot: () => relay,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => void relayListeners.delete(listener);
    },
  } as never);
  ctx.provide("navigation", {
    open,
    snapshot: () => ({ entry: { id: "home", target: { kind: "home" } } }),
    subscribe: () => () => {},
  } as never);
  ctx.provide("pages", {
    snapshot: () => pages,
    subscribe: () => () => {},
    registerOverlay(overlay: { component: ComponentType }) {
      Overlay = overlay.component;
    },
  } as never);
  ctx.provide("panels", {
    register(panel: { toolbar: ComponentType }) {
      Toolbar = panel.toolbar;
    },
  } as never);
  ctx.provide("speech", {
    listen(options: ListenOptions) {
      listens.push(options);
      options.onState?.("listening");
      return {
        stop: () => options.onState?.("idle"),
        cancel: () => options.onState?.("idle"),
      };
    },
  } as never);
  ctx.provide("decisions", { decide } as never);
  await act(() =>
    runtime.reconcile([
      {
        manifest: { id: "buzz.voice-jump", name: "Voice Jump", apiVersion: 1 },
        enabled: true,
        source: "bundled",
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      },
    ]),
  );
  await vi.waitFor(() =>
    expect(
      shortcuts
        .snapshot()
        .some((entry) => entry.key === "buzz.voice-jump/open"),
    ).toBe(true),
  );
  await import("./VoiceJumpDialog");
  render(
    <>
      <Toolbar />
      <Overlay />
    </>,
  );
  return { listens, decide, open, setRelay };
}

// Off Apple platforms, ⌘ is Ctrl.
const press = () =>
  fireEvent.keyDown(document.body, {
    key: "J",
    code: "KeyJ",
    ctrlKey: true,
    shiftKey: true,
  });

test("⇧⌘J listens, and a sure match opens that conversation while talking", async () => {
  const { listens, decide, open } = await mount();
  press();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  const listen = listens[0] as ListenOptions;
  // The hosted provider bills the community.
  expect(listen.community).toBe(communityOrigin);

  act(() => listen.onText("take me to design"));
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin },
      channelId: "design",
    }),
  );
  expect(decide).toHaveBeenCalledWith(
    expect.objectContaining({ community: communityOrigin }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("an unsure match lists the closest places to choose from", async () => {
  const { listens, decide, open } = await mount();
  decide.mockResolvedValue(
    answer("#launch", { "#design": 0.3, "#launch": 0.4 }),
  );
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  act(() => (listens[0] as ListenOptions).onEnd("lunch"));
  expect(
    await screen.findByText("Didn't find a great match. Closest places:"),
  ).toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("design"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "design" }),
  );
});

test("the mic beside Search opens the box listening", async () => {
  const { listens } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Jump by voice" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
});

test("a sure match for a plugin page opens that page", async () => {
  const { listens, decide, open } = await mount();
  decide.mockResolvedValue(
    answer("Page: Review Queue", {
      "Page: Review Queue": 0.92,
      "#design": 0.03,
    }),
  );
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  act(() => (listens[0] as ListenOptions).onText("open review queue"));
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "page",
      pluginId: "example.review-queue",
      pageId: "queue",
      scope: { viewer, communityOrigin },
    }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("plugin pages stay jumpable without a connected community", async () => {
  const { listens, decide, open } = await mount({ connected: false });
  decide.mockResolvedValue(
    answer("Page: Reminders", { "Page: Reminders": 0.4 }),
  );
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  act(() => (listens[0] as ListenOptions).onEnd("remind"));
  expect(
    await screen.findByText("Didn't find a great match. Closest places:"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("Reminders"));
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.reminders",
    pageId: "reminders",
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("closing the dialog cancels navigation for a pending decision", async () => {
  const pending = deferred<ReturnType<typeof answer>>();
  const { listens, decide, open } = await mount();
  decide.mockReturnValueOnce(pending.promise);
  press();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await vi.waitFor(() => expect(listens).toHaveLength(1));

  act(() => (listens[0] as ListenOptions).onText("take me to design"));
  expect(decide).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document.body, { key: "Escape" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  await act(async () => {
    pending.resolve(answer("#design", { "#design": 0.95, "#launch": 0.02 }));
    await pending.promise;
  });
  expect(open).not.toHaveBeenCalled();
});

test("a newer transcript supersedes an in-flight live or pause decision", async () => {
  const first = deferred<ReturnType<typeof answer>>();
  const second = deferred<ReturnType<typeof answer>>();
  const { listens, decide, open } = await mount();
  decide.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  const listen = listens[0] as ListenOptions;

  act(() => {
    listen.onText("design");
    listen.onPause?.("design");
    listen.onText("design, no, launch");
  });
  expect(decide).toHaveBeenCalledTimes(1);

  await act(async () => {
    first.resolve(answer("#design", { "#design": 0.95, "#launch": 0.02 }));
    await first.promise;
  });
  expect(open).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));

  await act(async () => {
    second.resolve(answer("#launch", { "#launch": 0.95, "#design": 0.02 }));
    await second.promise;
  });
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin },
      channelId: "launch",
    }),
  );
  expect(open).toHaveBeenCalledTimes(1);
});

test("a late decision after a speech error does not navigate", async () => {
  const pending = deferred<ReturnType<typeof answer>>();
  const { listens, decide, open } = await mount();
  decide.mockReturnValueOnce(pending.promise);
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  const listen = listens[0] as ListenOptions;

  act(() => {
    listen.onText("design");
    listen.onError?.("service_error", "Microphone lost.");
  });
  expect(await screen.findByText("Microphone lost.")).toBeInTheDocument();

  await act(async () => {
    pending.resolve(answer("#design", { "#design": 0.95, "#launch": 0.02 }));
    await pending.promise;
  });
  expect(open).not.toHaveBeenCalled();
});

test("switching communities while open invalidates cached places and restarts listening", async () => {
  const stale = deferred<ReturnType<typeof answer>>();
  const { listens, decide, open, setRelay } = await mount();
  decide.mockReturnValueOnce(stale.promise);
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));

  act(() => (listens[0] as ListenOptions).onText("design"));
  expect(decide).toHaveBeenCalledTimes(1);

  const otherOrigin = "wss://other.example.org";
  const otherChannels = [
    { id: "ops", name: "ops", channelType: "stream", lastActivityAt: 3 },
  ];
  const otherSession = {
    ...session,
    channels: {
      list: () => ({ channels: otherChannels }),
      get: (id: string) => otherChannels.find((channel) => channel.id === id),
      window: session.channels.window,
    },
  };
  decide.mockResolvedValueOnce(answer("#ops", { "#ops": 0.94 }));
  act(() =>
    setRelay({
      status: "ready",
      session: otherSession,
      viewer,
      origin: otherOrigin,
    }),
  );
  await vi.waitFor(() => expect(listens).toHaveLength(2));
  expect(listens[1]?.community).toBe(otherOrigin);

  // An in-flight answer from the old community must not navigate back.
  await act(async () => {
    stale.resolve(answer("#design", { "#design": 0.95, "#launch": 0.02 }));
    await stale.promise;
  });
  expect(open).not.toHaveBeenCalled();

  // The new community sends its own places, not the old community's cache.
  act(() => (listens[1] as ListenOptions).onText("ops"));
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: otherOrigin },
      channelId: "ops",
    }),
  );
  const secondRequest = decide.mock.calls[1]?.[0] as {
    state: string;
    community?: string;
  };
  expect(secondRequest.community).toBe(otherOrigin);
  expect(secondRequest.state).toContain("#ops");
  expect(secondRequest.state).not.toContain("#design");
});

test("Enter retries after a transient provider failure", async () => {
  const { listens, decide, open } = await mount();
  decide
    .mockResolvedValueOnce({
      outcome: "failed",
      backend: "test",
      reason: "timeout",
    } as never)
    .mockResolvedValueOnce(
      answer("#design", { "#design": 0.9, "#launch": 0.05 }),
    );
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));

  const field = screen.getByRole("searchbox", { name: "Where to" });
  fireEvent.change(field, { target: { value: "design" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(
    await screen.findByText("Couldn't match that just now. Try again."),
  ).toBeInTheDocument();
  expect(decide).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(field, { key: "Enter" });
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin },
      channelId: "design",
    }),
  );
});

test("without a community, hosted invalid_request falls back to local page matching or explains why", async () => {
  const { listens, decide, open } = await mount({ connected: false });
  decide.mockResolvedValue({
    outcome: "failed",
    backend: "builderlab",
    reason: "invalid_request",
  } as never);
  press();
  await vi.waitFor(() => expect(listens).toHaveLength(1));

  const field = screen.getByRole("searchbox", { name: "Where to" });
  fireEvent.change(field, { target: { value: "design" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(
    await screen.findByText(
      "Choose a community to use your Decisions provider, or enter a page name.",
    ),
  ).toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();

  fireEvent.change(field, { target: { value: "Review Queue" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "page",
      pluginId: "example.review-queue",
      pageId: "queue",
    }),
  );
});
