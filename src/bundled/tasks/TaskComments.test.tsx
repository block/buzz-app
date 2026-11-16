// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type {
  ChannelReach,
  ChannelReachState,
} from "../../features/relay/channel-reach";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, taskOf } from "./model";
import { TaskComments } from "./TaskComments";

afterEach(cleanup);

const home = "22222222-2222-4222-8222-222222222222";
const conversation = "33333333-3333-8333-8333-333333333333";
const task = taskOf({
  id: "d".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 2, author: "a".repeat(64) }),
  tags: [
    ["d", "11111111-1111-4111-8111-111111111111"],
    ["h", home],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
  ],
}) as Task;

/** Handles the test answers for, one per channel. */
function setup(options: { conversations?: boolean } = {}) {
  const handles = new Map<
    string,
    { set(state: ChannelReachState): void; retry: ReturnType<typeof vi.fn> }
  >();
  const reach = (id: string): ChannelReach => {
    let state: ChannelReachState = { status: "loading" };
    const listeners = new Set<() => void>();
    const retry = vi.fn();
    handles.set(id, {
      set(next) {
        state = next;
        for (const listener of listeners) listener();
      },
      retry,
    });
    return {
      snapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retry,
      release: () => {},
    };
  };
  const openConversation = vi.fn(async () => conversation);
  const session = {
    viewer: "a".repeat(64),
    channels: { reach },
    artifacts: {
      conversationId: async () => conversation,
      ...(options.conversations === false ? {} : { openConversation }),
    },
  } as unknown as RelaySession;
  const view = () =>
    render(
      <TaskComments
        session={session}
        scope="example.org"
        host={{} as ConversationHostServices}
        task={task}
      />,
    );
  return { handles, openConversation, view };
}

const answer = async (
  handles: ReturnType<typeof setup>["handles"],
  id: string,
  state: ChannelReachState,
) => {
  await vi.waitFor(() => expect(handles.has(id)).toBe(true));
  act(() => handles.get(id)?.set(state));
};

it("waits, without a composer, until the relay answers", async () => {
  const { handles, view } = setup();
  view();
  expect(screen.getByRole("status")).toHaveTextContent("Loading comments…");
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "unavailable",
  });
  // The home decides who may start the conversation; still asking.
  expect(screen.getByRole("status")).toHaveTextContent("Loading comments…");
  expect(screen.queryByRole("button")).toBeNull();
});

it("lets someone who can post in the task's home start its comments", async () => {
  const { handles, openConversation, view } = setup();
  view();
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "unavailable",
  });
  await answer(handles, home, { status: "open", post: true, joined: true });
  expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add a comment" }));
  expect(openConversation).toHaveBeenCalledWith(task.id, expect.anything());
});

it("offers a view-only person no way to start comments", async () => {
  const { handles, view } = setup();
  view();
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "unavailable",
  });
  await answer(handles, home, { status: "open", post: false, joined: false });
  expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  expect(screen.getByText("Read-only access")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});

it("offers to try again when the relay couldn't be asked", async () => {
  const { handles, view } = setup();
  view();
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "failed",
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t load comments.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(handles.get(conversation)?.retry).toHaveBeenCalled();
  expect(handles.get(home)?.retry).toHaveBeenCalled();
});

it("shows a failed home check with a retry, not an empty thread", async () => {
  const { handles, view } = setup();
  view();
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "unavailable",
  });
  await answer(handles, home, { status: "unavailable", reason: "failed" });
  expect(screen.queryByText("No comments yet.")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t load comments.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(handles.get(home)?.retry).toHaveBeenCalled();
});

it("says so where the community has no task comments", () => {
  setup({ conversations: false }).view();
  expect(
    screen.getByText("Comments aren’t available in this community yet."),
  ).toBeInTheDocument();
});

it("says plainly that a banned viewer is banned, with nothing to retry", async () => {
  const { handles, view } = setup();
  view();
  await answer(handles, conversation, {
    status: "unavailable",
    reason: "banned",
  });
  await answer(handles, home, { status: "unavailable", reason: "banned" });
  expect(
    screen.getByText("You’re banned from this community."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});
