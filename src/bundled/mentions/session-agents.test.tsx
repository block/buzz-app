// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { MentionPicker } from "./MentionPicker";
import { MentionCompletion } from "./MentionCompletion";
import { createAgentLibrary } from "../../features/agents/library";
import type { CompletionResult } from "../../features/conversation/contracts";
afterEach(cleanup);
function setup(parent: boolean | null = true, archived = false) {
  const key = "b".repeat(64),
    member = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: key, name: "Outside agent" }],
  }));
  const list = {
    status: "ready",
    channels:
      parent === null
        ? []
        : [
            {
              id: "parent",
              channelType: parent ? "stream" : "session",
              members: [member],
              archived,
            },
          ],
  };
  const profiles = new Map([[member, { name: "Member" }]]);
  const session = {
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: library.queries,
    media: () => undefined,
  } as unknown as RelaySession;
  return { session, library, key, member, profiles };
}
it("offers outside agents in the session mention picker while ordinary channel pickers keep their roster", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: `Outside agent ${test.key}` }),
  ).not.toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: `Outside agent ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  view.unmount();
  test.library.dispose();
});
it("focuses search on open and supports clear, Escape, and outside dismissal", async () => {
  const test = setup(),
    user = userEvent.setup();
  const view = render(
    <>
      <button type="button">Outside picker</button>
      <MentionPicker
        scope="scope"
        session={test.session}
        channelId="parent"
        disabled={false}
        select={() => true}
      />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Mention a member" });
  await user.click(trigger);
  const search = screen.getByRole("searchbox", {
    name: "Search members and your agents",
  });
  expect(search).toHaveFocus();
  await user.type(search, "no matching name");
  expect(screen.getByText("No matching channel members.")).toBeVisible();
  await user.click(
    screen.getByRole("button", {
      name: "Clear search members and your agents",
    }),
  );
  expect(search).toHaveFocus();
  expect(search).toHaveValue("");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  const outside = screen.getByRole("button", { name: "Outside picker" });
  await user.click(outside);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(outside).toHaveFocus();
  view.unmount();
  test.library.dispose();
});
it("navigates namesakes with arrows and selects the focused exact identity with Enter", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  test.profiles.set(test.member, { name: "Outside agent" });
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const first = await screen.findByRole("button", {
    name: `Outside agent ${test.key}`,
  });
  const last = screen.getByRole("button", {
    name: `Outside agent ${test.member}`,
  });
  await user.keyboard("{ArrowDown}");
  expect(first).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(last).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(first).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.member,
    name: "Outside agent",
  });
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("selects filtered results from search, ignores IME Enter, and keeps rejected selections open", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => false);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const search = screen.getByRole("searchbox");
  expect(
    screen.queryByText("Your agents are added to this channel when you send."),
  ).not.toBeInTheDocument();
  await user.type(search, "missing");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(search).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(search);
  await user.type(search, test.member);
  fireEvent.keyDown(search, { key: "Enter", isComposing: true });
  expect(fireEvent.keyDown(search, { key: "Enter", shiftKey: true })).toBe(
    false,
  );
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.member,
    name: "Member",
  });
  expect(search).toHaveFocus();
  select.mockReturnValue(true);
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("does not keyboard-select disabled members", async () => {
  const test = setup(true, true),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  test.library.dispose();
});

it.each([true, false, null])(
  "typed @ completion offers outside agents with correct admission: parent=%s",
  async (parent) => {
    const test = setup(parent);
    let result: CompletionResult | undefined;
    const publish = vi.fn((next: CompletionResult) => {
      result = next;
      return () => {};
    });
    const props = {
      session: test.session,
      scope: "test",
      channelId: "parent",
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish,
    };
    const view = render(<MentionCompletion {...props} inviteAgents />);
    await waitFor(() =>
      expect(result?.items).toEqual([
        expect.objectContaining({
          id: test.key,
          detail: expect.stringContaining(
            parent ? "Adds to session and parent channel" : "Adds to session ·",
          ),
          edit: { mention: { pubkey: test.key, name: "Outside agent" } },
        }),
      ]),
    );
    if (parent === null) {
      expect(result?.status).toBeUndefined();
      expect(result?.retry).toBeUndefined();
    }
    view.rerender(<MentionCompletion {...props} />);
    await waitFor(() => expect(result?.items).toHaveLength(0));
    view.unmount();
    test.library.dispose();
  },
);
