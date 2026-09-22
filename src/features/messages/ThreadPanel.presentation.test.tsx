// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { ThreadPanel } from "./ThreadPanel";

const owners: ReturnType<typeof sessionsData>[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const h of owners.splice(0)) h.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const h = sessionsData({ rowCount: 0 });
  owners.push(h);
  h.session.channels.ensureList();
  await waitFor(() => expect(h.session.channels.list().status).toBe("ready"));
  h.session.channels.ensure("general");
  await waitFor(() =>
    expect(h.session.channels.window("general").status).toBe("ready"),
  );
  const root = h.session.channels
    .window("general")
    .rows.find((row) => row.content === "Unanswered agent request");
  if (!root) throw new Error("Missing root");
  return {
    h,
    props: {
      session: h.session,
      scope: "sessions-fixture",
      channelId: "general",
      channelName: "General",
      messageId: root.id,
      close: vi.fn(),
      onOpenLink: () => false,
    },
  };
}
it.each(["thread", "session"] as const)(
  "%s presentation keeps one existing reader and its explicit composer",
  async (presentation) => {
    const { h, props } = await setup();
    const mounted = render(
      <ThreadPanel {...props} presentation={presentation} />,
      { reactStrictMode: true },
    );
    const area = screen.getByRole("complementary", {
      name: presentation === "session" ? "Session" : "Thread",
    });
    await waitFor(() => expect(h.threadSnapshot()?.status).toBe("ready"));
    const back = within(area).getByRole("button", {
      name: presentation === "session" ? "Back to Sessions" : "Close thread",
    });
    expect(back).toHaveFocus();
    expect(h.report.activeReaders).toBe(1);
    if (presentation === "session") {
      expect(
        within(area).getByRole("heading", { name: "Unanswered agent request" }),
      ).toBeInTheDocument();
      expect(
        within(area).queryByText("0 replies shown"),
      ).not.toBeInTheDocument();
      expect(
        within(area).getByRole("textbox", { name: "Message this session" }),
      ).toBeInTheDocument();
    } else {
      expect(within(area).getByText("0 replies shown")).toBeInTheDocument();
      expect(
        within(area).getByRole("textbox", { name: "Reply to thread" }),
      ).toBeInTheDocument();
    }
    const readers = h.report.readers;
    mounted.rerender(
      <ThreadPanel
        {...props}
        channelName="Renamed"
        presentation={presentation}
      />,
    );
    expect(h.report.readers).toBe(readers);
    expect(back).toHaveFocus();
    fireEvent.click(back);
    expect(props.close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(props.close).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(h.report.activeReaders).toBe(0);
  },
);
it("session back remains focused through held loading and failed read, then retry uses the same owned reader", async () => {
  const { h, props } = await setup();
  h.failThread(true);
  const gate = h.holdThread();
  render(<ThreadPanel {...props} presentation="session" />, {
    reactStrictMode: true,
  });
  const back = screen.getByRole("button", { name: "Back to Sessions" });
  try {
    await act(async () => {
      await gate.started;
    });
    expect(back).toHaveFocus();
    expect(screen.getByText("Loading session…")).toBeInTheDocument();
    expect(h.report.activeReaders).toBe(1);
  } finally {
    await act(async () => {
      gate.release();
    });
  }
  const retry = await screen.findByRole("button", { name: "Retry session" });
  expect(back).toHaveFocus();
  const readers = h.report.readers;
  h.failThread(false);
  fireEvent.click(retry);
  await screen.findByRole("heading", { name: "Unanswered agent request" });
  await waitFor(() => expect(h.threadSnapshot()?.status).toBe("ready"));
  expect(h.report.readers).toBe(readers);
});

it.each(["thread", "session"] as const)(
  "%s presentation labels the bounded history without changing its reader",
  async (presentation) => {
    const { h, props } = await setup();
    const snapshot = {
      status: "ready" as const,
      root: undefined,
      replies: [],
      error: undefined,
      canLoadMore: false,
      limited: true,
    };
    vi.spyOn(h.session, "thread").mockReturnValue({
      snapshot: () => snapshot,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      dispose: () => {},
    });
    render(<ThreadPanel {...props} presentation={presentation} />, {
      reactStrictMode: true,
    });
    expect(
      screen.getByText(
        presentation === "session"
          ? "Session history limit reached."
          : "Thread history limit reached.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Loading (session|thread)/),
    ).not.toBeInTheDocument();
  },
);
