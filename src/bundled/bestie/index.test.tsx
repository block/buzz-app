// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginModule } from "../../plugins/api";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerTool,
} from "../../features/conversation/contracts";
import type { Panel } from "../../features/panels/service";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createRelaySession } from "../../features/relay/session";
import type { MemoryReader } from "../../features/agents/memory";
import type { RelayEvent } from "../../features/relay/events";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
  summary,
} from "../../features/relay/testing";
import * as mentions from "../mentions";
import { apply } from "./index";

// Test panel/message wiring, not virtual scrolling geometry (jsdom has no layout).
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children: ReactNode }) => <ol>{children}</ol>,
}));

composerDOMFixture();
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

it("mentions a relay-only agent and opens its threaded reply in Bestie", async () => {
  // jsdom has no layout; give the real timeline a measurable viewport.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const agent = keypair();
  const relay = keypair();
  const name = "bestie-lab-fresh";
  const channel = "lab-channel";
  const root = message(viewer, channel, "Let's do onboarding", 1_700_000_001);
  const reply = message(
    agent,
    channel,
    "What would you like to call me?",
    1_700_000_002,
    [["e", root.id, "", "reply"]],
  );
  const threadSummary = summary(relay, channel, root.id, {
    reply_count: 1,
    participants: [agent.pubkey],
  });
  let memoryBody = "Likes tacos";
  const readMemories = vi.fn<MemoryReader>(async () => ({
    partial: false,
    entries: [
      {
        slug: "mem/user",
        body: memoryBody,
        eventId: "a".repeat(64),
        createdAt: 1_700_000_003,
      },
    ],
  }));
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) =>
          filter.ids
            ? [root].filter((event) => filter.ids?.includes(event.id))
            : filter["#e"] && filter.kinds?.includes(9)
              ? [reply]
              : filter.kinds?.includes(39002)
                ? [roster(relay, channel, [viewer.pubkey, agent.pubkey])]
                : filter.kinds?.includes(39000)
                  ? [metadata(relay, channel, "Lab")]
                  : filter.kinds?.includes(0)
                    ? [profile(agent, { name })]
                    : filter.kinds?.includes(9)
                      ? [
                          root,
                          threadSummary,
                          bounds(relay, channel, "head", {
                            has_more: false,
                            next_cursor: null,
                          }),
                        ]
                      : [],
        ),
      readAgentMemories: readMemories,
      readAgentLibrary: async () => ({ definitions: [], identities: [] }),
      writer: {
        kinds: [9],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  // Exercise the actual plugin registration and components. The host only
  // supplies contribution registries and a real session with a fixture relay.
  const completions: Contribution<ComposerCompletion>[] = [];
  const tools: Contribution<ComposerTool>[] = [];
  const registered: Panel[] = [];
  const emptyInline = Object.freeze([]);
  const conversation = {
    completions: { snapshot: () => completions, subscribe: () => () => {} },
    tools: { snapshot: () => tools, subscribe: () => () => {} },
    inline: { snapshot: () => emptyInline, subscribe: () => () => {} },
    registerCompletion: (item: ComposerCompletion) =>
      completions.push({
        ...item,
        key: item.id,
        pluginId: "buzz.mentions",
        revision: "1",
      }),
    registerTool: (item: ComposerTool) =>
      tools.push({
        ...item,
        key: item.id,
        pluginId: "buzz.mentions",
        revision: "1",
      }),
  };
  const snapshot = {
    status: "ready",
    scope: "lab-test",
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const ctx = {
    conversation,
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    panels: { register: (panel: Panel) => registered.push(panel) },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  try {
    await mentions.apply(ctx);
    await apply(ctx);
    localStorage.setItem("buzz.bestie.channelId", channel);
    const PanelComponent = registered[0]?.component;
    if (!PanelComponent) throw new Error("Bestie panel was not registered");
    render(<PanelComponent target="" close={() => {}} />);
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox");
    await waitFor(() =>
      expect(input).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(input);
    await user.type(input, "@bestie-lab");
    await user.click(
      await screen.findByRole("option", { name: new RegExp(name) }),
    );
    expect(input.querySelector(".inline-chip")).not.toBeNull();
    await user.paste("hello");
    expect(input.querySelector(".inline-chip")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const event = publish.mock.calls[0]?.[0];
    expect(event).toMatchObject({ kind: 9 });
    expect(event?.tags).toContainEqual(["p", agent.pubkey]);
    expect(event?.tags).toContainEqual(["h", channel]);
    await user.click(
      await screen.findByRole("button", { name: /^View thread: 1 reply/ }),
    );
    expect(await screen.findByText(reply.content)).toBeVisible();
    expect(readMemories).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Memories" }));
    await user.click(await screen.findByText("mem/user"));
    expect(screen.getByText("Likes tacos")).toBeVisible();
    expect(readMemories).toHaveBeenCalledWith(
      agent.pubkey,
      expect.any(AbortSignal),
    );
    memoryBody = "Likes tacos and short plans";
    await user.click(screen.getByRole("button", { name: "Refresh memories" }));
    await user.click(await screen.findByText("mem/user"));
    expect(screen.getByText(memoryBody)).toBeVisible();
    expect(screen.queryByText("Likes tacos")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close memories" }));
    await waitFor(() =>
      expect(screen.queryByText(memoryBody)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(reply.content)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close thread" }));
    expect(
      screen.queryByRole("complementary", { name: "Thread" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^View thread: 1 reply/ }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});
