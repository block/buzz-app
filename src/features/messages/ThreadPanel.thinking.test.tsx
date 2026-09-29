// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubPopoverBrowserApis } from "../../bundled/agent-activity/popover-testing";
stubPopoverBrowserApis();
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TypingPresentation } from "../conversation/typing-presentation";
import { ThreadPanel } from "./ThreadPanel";
import { threadThinkingFixture } from "./thread-thinking-testing";

vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./use-reading", () => ({ useReading: () => {} }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("shows one static-avatar working row in the matching thread and replaces it with the reply", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const f = await threadThinkingFixture();
  await f.session.profiles.ensure([f.agent]);
  try {
    const props = {
      session: f.session,
      extensions: f.extensions,
      scope: "preview",
      channelName: "Design",
      channelId: "channel",
      close() {},
      onOpenLink: () => false,
    };
    const view = render(
      <TypingPresentation active>
        <section aria-label="Onboarding thread">
          <ThreadPanel {...props} messageId={f.first.id} />
        </section>
        <section aria-label="Notifications thread">
          <ThreadPanel {...props} messageId={f.second.id} />
        </section>
      </TypingPresentation>,
    );
    const active = () =>
      [...view.container.querySelectorAll(".buzz-shimmer[data-active]")].map(
        (node) =>
          node.closest('[aria-label="Onboarding thread"]')
            ? "onboarding"
            : "notifications",
      );
    const firstAvatar = "onboarding";
    const secondAvatar = "notifications";
    act(() => {
      f.observe("turn_started", "unlinked");
    });
    expect(active()).toEqual([]); // Unlinked observer work cannot identify a thread.
    act(() => {
      f.signal(f.first.id, 20002, "elsewhere");
    });
    expect(active()).toEqual([]);
    act(() => {
      f.signal(f.first.id);
    });
    expect(active()).toEqual([firstAvatar]);
    act(() => {
      f.signal(f.second.id);
    });
    expect(active()).toEqual([firstAvatar, secondAvatar]);
    expect(
      view.container.querySelectorAll(
        '[data-message-id] [data-thinking="true"]',
      ),
    ).toHaveLength(0);
    act(() => {
      f.start(f.first.id);
      f.respond(f.first.id);
    });
    expect(
      view.getByText(
        "I've checked the latest copy. The onboarding steps read clearly now.",
      ),
    ).toBeVisible();
    expect(active()).toEqual([secondAvatar]);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(active()).toEqual([]);
    act(() => {
      f.start(f.first.id);
    });
    expect(active()).toEqual([firstAvatar]);
    act(() => {
      f.signal(f.first.id);
      f.finish(f.first.id);
    });
    expect(active()).toEqual([]); // Terminal activity wins over typing.
    act(() => {
      f.start(f.first.id);
    });
    expect(active()).toEqual([firstAvatar]);
    view.rerender(
      <TypingPresentation active>
        <section aria-label="Notifications thread">
          <ThreadPanel {...props} messageId={f.second.id} />
        </section>
      </TypingPresentation>,
    );
    expect(active()).toEqual([]); // Retargeting cannot carry the first thread's work.
    act(() => {
      f.start(f.second.id);
    });
    expect(active()).toEqual([secondAvatar]);
    act(() => {
      f.activity.state({ status: "retrying", routes: [] });
    });
    expect(active()).toEqual([]);
    view.unmount();
  } finally {
    await f.dispose();
  }
});
