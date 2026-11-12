// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCompletionNotifications } from "./AgentCompletionNotifications";
import { createLocalAgentActivity } from "../agents/local-activity";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "./preferences";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { playNotificationSound } from "./sound";
vi.mock("./sound", async (original) => ({
  ...(await original<typeof import("./sound")>()),
  playNotificationSound: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each([true, false])(
  "keeps foreground completion feedback while respecting conversation silence=%s",
  async (quiet) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const activity = createLocalAgentActivity();
    const viewer = "a".repeat(64);
    const services = {
      agentActivity: activity.reader,
      agents: {
        local: () => ({ agents: [{ pubkey: "agent", name: "Scout" }] }),
      },
      navigation: {
        snapshot: () => ({ entry: { target: { version: 1, kind: "home" } } }),
        open: vi.fn(),
      },
      notifications: {
        snapshot: () => ({
          developmentPaused: false,
          preferences: {
            ...DEFAULT_NOTIFICATION_PREFERENCES,
            quietConversations: quiet
              ? [{ communityOrigin: "https://buzz.example", channelId: "chat" }]
              : [],
          },
        }),
      },
    };
    render(
      <ToastProvider>
        <AgentCompletionNotifications services={services as never} />
      </ToastProvider>,
    );
    act(() => {
      const work = activity.begin({
        scope: `https://buzz.example:${viewer}`,
        agent: "agent",
        channelId: "chat",
        messageId: "b".repeat(64),
        threadRootId: "b".repeat(64),
        soloChat: true,
        conversationName: "Release check",
      });
      work.started();
      work.finish({ ok: true });
    });
    expect(
      await screen.findByText("Scout is done in Release check"),
    ).toBeTruthy();
    expect(playNotificationSound).toHaveBeenCalledTimes(quiet ? 0 : 1);
  },
);
