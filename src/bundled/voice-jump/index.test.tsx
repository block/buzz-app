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

async function mount() {
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
  const listens: ListenOptions[] = [];
  const decide = vi.fn(async (_request: unknown) =>
    answer("#design", { "#design": 0.9, "#launch": 0.05 }),
  );
  const open = vi.fn(async () => ({ status: "opened" }));
  const relay = { status: "ready", session, viewer, origin: communityOrigin };
  ctx.provide("relay", {
    snapshot: () => relay,
    subscribe: () => () => {},
  } as never);
  ctx.provide("navigation", {
    open,
    snapshot: () => ({ entry: { id: "home", target: { kind: "home" } } }),
    subscribe: () => () => {},
  } as never);
  ctx.provide("pages", {
    registerOverlay(overlay: { component: ComponentType }) {
      Overlay = overlay.component;
    },
  } as never);
  ctx.provide("speech", {
    prepare() {},
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
  render(<Overlay />);
  return { listens, decide, open };
}

// Off Apple platforms, ⌘ is Ctrl.
const press = () =>
  fireEvent.keyDown(document.body, {
    key: "K",
    code: "KeyK",
    ctrlKey: true,
    shiftKey: true,
  });

test("⇧⌘K listens, and a sure match opens that conversation while talking", async () => {
  const { listens, decide, open } = await mount();
  press();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await vi.waitFor(() => expect(listens).toHaveLength(1));
  const listen = listens[0] as ListenOptions;
  // The hosted provider bills the community; on-device hears the names.
  expect(listen.community).toBe(communityOrigin);
  expect(listen.hints).toEqual(["design", "launch"]);

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
