// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { ReactionHistory } from "./ReactionHistory";
import {
  readReactionPage,
  type ReactionEntry,
} from "../../features/relay/reaction-history";
import type { RelaySession } from "../../features/relay/session";

vi.mock("../../features/relay/reaction-history", async (original) => ({
  ...(await original<typeof import("../../features/relay/reaction-history")>()),
  readReactionPage: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const reaction: ReactionEntry = {
  id: "reaction",
  authorId: "alice",
  channelId: "room",
  messageId: "message",
  rootId: "root",
  createdAt: 100,
  content: "✅",
  preview: "Ready for review",
};
function setup() {
  const listeners = new Set<() => void>();
  let snapshot = {
    status: "ready",
    channels: [{ id: "room", name: "Team", members: ["me", "alice"] }],
  };
  const profiles = new Map([["alice", { pubkey: "alice", name: "Alice" }]]);
  const session = {
    viewer: "me",
    reactionHistory: (cursor: unknown, options: { signal: AbortSignal }) =>
      readReactionPage({} as never, [], options.signal, cursor as never),
    channels: {
      list: () => snapshot,
      ensureList: () => {},
      subscribeList: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    media: () => undefined,
  } as unknown as RelaySession;
  return {
    session,
    revoke() {
      snapshot = { status: "ready", channels: [] };
      for (const fn of listeners) fn();
    },
  };
}
it("opens the exact reacted-to reply, refreshes, and removes rows on access loss", async () => {
  const h = setup();
  const open = vi.fn(() => true);
  vi.mocked(readReactionPage).mockResolvedValue({
    rows: [reaction],
    cursor: undefined,
  });
  render(
    <StrictMode>
      <ReactionHistory session={h.session} open={open} />
    </StrictMode>,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open message reacted to by Alice",
    }),
  );
  expect(open).toHaveBeenCalledWith({
    channelId: "room",
    threadId: "root",
    messageId: "message",
  });
  expect(screen.getByText("Ready for review")).toBeTruthy();
  vi.mocked(readReactionPage).mockResolvedValue({
    rows: [],
    cursor: undefined,
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh reactions" }));
  await screen.findByText("No reactions yet");
  act(() => h.revoke());
  expect(screen.queryByText("Ready for review")).toBeNull();
});
it("ignores an in-flight completion after membership revocation", async () => {
  const h = setup();
  let finish!: (value: { rows: ReactionEntry[]; cursor: undefined }) => void;
  vi.mocked(readReactionPage)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ rows: [], cursor: undefined });
  render(<ReactionHistory session={h.session} open={() => true} />);
  await waitFor(() => expect(readReactionPage).toHaveBeenCalled());
  act(() => h.revoke());
  await act(async () => finish({ rows: [reaction], cursor: undefined }));
  expect(screen.queryByText("Ready for review")).toBeNull();
});
it("keeps the newest reaction when an older page repeats the same person's emoji", async () => {
  const h = setup();
  vi.mocked(readReactionPage)
    .mockResolvedValueOnce({
      rows: [reaction],
      cursor: { until: 100, before_id: "reaction" },
    })
    .mockResolvedValueOnce({
      rows: [{ ...reaction, id: "older", createdAt: 90 }],
      cursor: undefined,
    });
  render(<ReactionHistory session={h.session} open={() => true} />);
  await screen.findByText("Ready for review");
  fireEvent.click(screen.getByRole("button", { name: "Load older reactions" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load older reactions" }),
    ).toBeNull(),
  );
  expect(
    screen.getAllByRole("button", { name: "Open message reacted to by Alice" }),
  ).toHaveLength(1);
});
it("groups people and emoji counts by post across older pages", async () => {
  const h = setup();
  vi.mocked(readReactionPage)
    .mockResolvedValueOnce({
      rows: [reaction],
      cursor: { until: 100, before_id: "reaction" },
    })
    .mockResolvedValueOnce({
      rows: [
        { ...reaction, id: "bob", authorId: "bob", createdAt: 90 },
        { ...reaction, id: "other-emoji", content: "🎉", createdAt: 80 },
        {
          ...reaction,
          id: "other-post",
          messageId: "other",
          preview: "Another post",
          createdAt: 70,
        },
      ],
      cursor: undefined,
    });
  const open = vi.fn(() => true);
  render(<ReactionHistory session={h.session} open={open} />);
  await screen.findByText("Ready for review");
  fireEvent.click(screen.getByRole("button", { name: "Load older reactions" }));
  const grouped = await screen.findByRole("button", {
    name: "Open message reacted to by Alice +1",
  });
  expect(screen.getAllByText("Ready for review")).toHaveLength(1);
  expect(grouped.textContent).toContain("✅ 2");
  expect(grouped.textContent).toContain("🎉 1");
  expect(screen.getByText("Another post")).toBeTruthy();
  fireEvent.click(grouped);
  expect(open).toHaveBeenCalledWith({
    channelId: "room",
    threadId: "root",
    messageId: "message",
  });
});
