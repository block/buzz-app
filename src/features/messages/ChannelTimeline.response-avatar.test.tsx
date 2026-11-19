// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createRelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { ChannelTimeline } from "./ChannelTimeline";
import { agent, human, fixture } from "./typing-indicator-testing";

stubAvatarBrowserApis();

// Render the real timeline and rows; only the independent virtualizer's
// measurement contract is controlled in jsdom.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: import("react").ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        viewportSize: 600,
        cache: [[], 40],
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollTo: vi.fn(),
        scrollToIndex: vi.fn(),
      }));
      return <ol aria-label="Virtualized messages">{children}</ol>;
    }),
  };
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.messageDensity;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("plays the visible compact retry portrait after a folded public failure", async () => {
  document.documentElement.dataset.messageDensity = "compact";
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: no-preference)",
    addEventListener() {},
    removeEventListener() {},
  }));
  const loads: Array<{ src: string; onload: (() => void) | null }> = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = null;
      constructor() {
        loads.push(this);
      }
    },
  );
  const owner = createRelaySession(null);
  const live = fixture();
  const source = `https://community.test/media/${"9".repeat(64)}.webp`;
  const media = (url: string, size?: "small") =>
    size ? "still" : `protected:${url}`;
  const profile = { name: "Agent", picture: source, isAgent: true as const };
  (live.session.profiles.snapshot() as Map<string, typeof profile>).set(
    agent,
    profile,
  );
  const session = {
    ...owner.session,
    typing: live.session.typing,
    agentActivity: live.session.agentActivity,
    agentChoices: live.session.agentChoices,
    profiles: live.session.profiles,
    media,
  };
  const row = (
    id: string,
    createdAt: number,
    extra: Partial<ChannelMessage> = {},
  ): ChannelMessage => ({
    id,
    channelId: "channel",
    authorId: agent,
    replyParentId: "request",
    content: id,
    createdAt,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...extra,
  });
  const rows = [
    row("request", 100, { authorId: human, replyParentId: undefined }),
    row("step", 101, { audience: "agents" }),
    row("failure", 102, { notice: "execution-failure" }),
    row("first-retry", 103),
    row("last-retry", 104),
  ];
  const view = render(
    <ChannelTimeline
      channelId="channel"
      scope="folded-response-avatar"
      queries={session}
      chatPresentation
      window={{
        channelId: "channel",
        rows,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        freshness: "verified",
        error: undefined,
      }}
      onOpenLink={() => false}
    />,
  );
  const animations = () =>
    view.container.querySelectorAll(`img[src="protected:${source}"]`);
  try {
    expect(
      screen.getByRole("button", { name: /Show activity history/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector('[data-message-id="step"]')).toBeNull();
    expect(
      view.container.querySelector('[data-message-id="failure"]'),
    ).toBeNull();
    const first = view.container.querySelector(
      '[data-message-id="first-retry"]',
    );
    const last = view.container.querySelector('[data-message-id="last-retry"]');
    expect(
      first?.querySelector("[data-highlight-surface]"),
    ).not.toHaveAttribute("data-stack-previous");
    expect(last?.querySelector("[data-highlight-surface]")).toHaveAttribute(
      "data-stack-previous",
      "true",
    );
    expect(loads).toHaveLength(0);
    live.update([{ pubkey: agent, channelId: "channel" }]);
    expect(loads).toHaveLength(1);
    expect(animations()).toHaveLength(0);
    act(() => loads[0]?.onload?.());
    expect(animations()).toHaveLength(1);
    expect(animations()[0]?.closest("[data-message-id]")).toBe(first);
    expect(
      first?.querySelector(`img[src="protected:${source}"]`),
    ).toBeVisible();
    expect(last?.querySelector(`img[src="protected:${source}"]`)).toBeNull();
    live.update([]);
    await waitFor(() => expect(animations()).toHaveLength(0));
    expect(first?.querySelector('img[src="still"]')).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});
