// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import { RecentThreads } from "./RecentThreads";
import { createThreadNavigation, type ThreadRecord } from "./recent-threads";

const scope = `https://relay.test:${"c".repeat(64)}`;
const root = (index: number, channelId = "general"): ChannelMessage => ({
  id: index.toString(16).padStart(64, "0"),
  channelId,
  authorId: "b".repeat(64),
  content: `Thread ${index}`,
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});
const channels: ChannelSummary[] = [
  { id: "general", name: "General", channelType: "stream" },
];
const owners: ReturnType<typeof createNavigationController>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
const stores: ReturnType<typeof createThreadNavigation>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
function fixture(total = 1) {
  const saved = new Map<string, ThreadRecord>();
  let time = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => ++time);
  const host = {
    read: vi.fn(async () => [...saved.values()]),
    write: vi.fn(async (record: ThreadRecord) => {
      saved.set(`${record.type}:${record.channelId}:${record.rootId}`, record);
      return record;
    }),
  };
  const makeStore = () => {
    const store = createThreadNavigation(host, new AbortController().signal);
    stores.push(store);
    return store;
  };
  const store = makeStore();
  for (let i = 1; i <= total; i++) store.visit(root(i));
  const owner = createNavigationController(createMemoryHistory());
  owners.push(owner);
  const props = {
    scope,
    navigator: owner.navigation,
    target: owner.navigation.snapshot().entry.target,
    channels,
    filter: "all" as const,
    store,
  };
  return { owner, props, host, makeStore, saved };
}
const settled = async (store: ReturnType<typeof createThreadNavigation>) => {
  await waitFor(() => expect(store.snapshot().pending).toHaveLength(0));
};
const rows = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.textContent?.startsWith("Thread "));
const names = () => rows().map((button) => button.textContent);

it("pins in stable order, preserves visit order on unpin, persists and reopens the exact thread", async () => {
  const user = userEvent.setup();
  const { props, owner, makeStore } = fixture(3);
  const mounted = render(<RecentThreads {...props} />);
  await settled(props.store);
  expect(names()).toEqual([
    "Thread 3General",
    "Thread 2General",
    "Thread 1General",
  ]);
  await user.click(
    screen.getByRole("button", { name: "Actions for Thread 1" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Pin thread" }));
  await settled(props.store);
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitem", { name: "Unpin thread" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Thread 2" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Pin thread" }));
  act(() => props.store.visit(root(4)));
  expect(names()).toEqual([
    "Thread 1General",
    "Thread 2General",
    "Thread 4General",
    "Thread 3General",
  ]);
  expect(
    within(screen.getByRole("button", { name: /^Thread 1General/ })).getByRole(
      "img",
      { name: "Pinned" },
    ),
  ).toBeInTheDocument();
  await settled(props.store);
  mounted.unmount();
  const restored = makeStore();
  render(<RecentThreads {...props} store={restored} />);
  await screen.findByRole("button", { name: /^Thread 1General/ });
  expect(names()[0]).toBe("Thread 1General");
  await user.click(screen.getByRole("button", { name: /^Thread 1General/ }));
  expect(owner.navigation.snapshot().entry.target).toMatchObject({
    kind: "conversation",
    channelId: "general",
    messageId: root(1).id,
    threadRootId: root(1).id,
    scope: { viewer: "c".repeat(64), communityOrigin: "https://relay.test" },
  });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Thread 1General/ }), {
    key: "F10",
    shiftKey: true,
  });
  await user.click(
    await screen.findByRole("menuitem", { name: "Unpin thread" }),
  );
  expect(names()).toEqual([
    "Thread 2General",
    "Thread 4General",
    "Thread 3General",
    "Thread 1General",
  ]);
});

it("shows eight initially, expands eight at a time, folds, and keeps all pins plus three recents when full", async () => {
  const user = userEvent.setup();
  const { props } = fixture(20);
  render(<RecentThreads {...props} />);
  expect(rows()).toHaveLength(8);
  const first = rows()[0];
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(rows()).toHaveLength(16);
  expect(rows()[0]).toBe(first);
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(rows()).toHaveLength(20);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show less" }));
  expect(rows()).toHaveLength(8);
  expect(first).toHaveFocus();
  await settled(props.store);
  act(() => {
    for (const entry of props.store.snapshot().entries.slice(-9))
      props.store.pin(entry, true);
  });
  expect(rows()).toHaveLength(12);
  expect(
    rows()
      .slice(0, 9)
      .every((row) => within(row).queryByLabelText("Pinned")),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(rows()).toHaveLength(20);
  await user.click(screen.getByRole("button", { name: "Show less" }));
  await settled(props.store);
  await user.click(
    screen.getByRole("button", { name: "Actions for Thread 3" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Unpin thread" }),
  );
  expect(
    screen.queryByRole("button", { name: /^Thread 3General/ }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(rows()[0]).toHaveFocus());
});

it("respects scope filters and hides unavailable channel metadata", () => {
  const { props } = fixture();
  props.store.visit(root(2, "solo"));
  props.store.visit(root(3, "archived"));
  props.store.visit(root(4, "missing"));
  const list: ChannelSummary[] = [
    ...channels,
    { id: "solo", name: "Solo chat", channelType: "solo" },
    { id: "archived", name: "Archived", archived: true },
  ];
  const mounted = render(
    <RecentThreads {...props} channels={list} filter="team" />,
  );
  expect(names()).toEqual(["Thread 1General"]);
  mounted.rerender(<RecentThreads {...props} channels={list} filter="solo" />);
  expect(names()).toEqual(["Thread 2Solo chat"]);
  mounted.rerender(
    <RecentThreads
      {...props}
      channels={[{ id: "general", name: "General", cached: true }]}
    />,
  );
  expect(screen.queryByText("Recent")).not.toBeInTheDocument();
});

it("rolls back a failed pin and retries the intended choice", async () => {
  const user = userEvent.setup();
  const { props, host } = fixture();
  render(<RecentThreads {...props} />);
  await settled(props.store);
  host.write.mockRejectedValueOnce(new Error("offline"));
  await user.click(
    screen.getByRole("button", { name: "Actions for Thread 1" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Pin thread" }));
  await settled(props.store);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t save thread navigation",
  );
  expect(screen.queryByLabelText("Pinned")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await settled(props.store);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
});
