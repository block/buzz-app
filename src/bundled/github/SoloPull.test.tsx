import { MenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { ChannelMessage } from "../../features/relay/contracts";
import {
  ChatPullMessageAction,
  hasChatPullAction,
} from "./ChatPullMessageAction";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { apply } from "./index";
import { setOpenGitHubLinksInBuzz } from "./link-preference";
import type { SoloPull, SoloPulls } from "./solo-pull";
import {
  SoloPullIcon,
  SoloPullLink,
  SoloPullMenu,
  SessionPullLauncher,
  SoloPullLauncher,
} from "./SoloPull";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const chat = "11111111-1111-4111-8111-111111111111";
const team = "22222222-2222-4222-8222-222222222222";
const viewer = "c".repeat(64);
const pull = "https://github.com/block/buzz-app/pull/7";

function fakePulls(initial: Record<string, SoloPull> = {}) {
  const links = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  return {
    watch: vi.fn((_channel: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    get: (channel: string) => links.get(channel),
    linked: vi.fn((channel: string, url: string | null) => {
      if (url) links.set(channel, { url });
      else links.delete(channel);
      for (const listener of listeners) listener();
    }),
  } satisfies SoloPulls;
}

it("stands in for the chat icon with the pull request's state, in words too", () => {
  const pulls = fakePulls({
    [chat]: {
      url: pull,
      state: { state: "open", checks: "failure", conflicts: true },
    },
  });
  const { container, rerender } = render(
    <SoloPullIcon pulls={pulls} channelId={chat} fallback="bubble" />,
  );
  expect(
    screen.getByText("Pull request, open, checks failing, conflicts:"),
  ).toBeInTheDocument();
  expect(container.querySelector("[data-tone]")).toHaveAttribute(
    "data-tone",
    "failure",
  );
  for (const [state, words, tone] of [
    [{ state: "merged" }, "Pull request, merged:", "merged"],
    [
      { state: "draft", checks: "pending" },
      "Pull request, draft, checks running:",
      "draft",
    ],
    [{ state: "open", checks: "success" }, "Pull request, open:", "open"],
  ] as const) {
    rerender(
      <SoloPullIcon
        pulls={fakePulls({ [chat]: { url: pull, state } })}
        channelId={chat}
        fallback="bubble"
      />,
    );
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(container.querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      tone,
    );
  }
  rerender(<SoloPullIcon pulls={pulls} channelId={team} fallback="bubble" />);
  expect(container).toHaveTextContent(/^bubble$/);
});

function relayWith(channels: { id: string; channelType: string }[]) {
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: viewer,
    sig: "",
  }));
  let head: EventData | undefined;
  const publish = vi.fn(async (event: EventData) => {
    head = event;
    return "";
  });
  const list = {
    status: "ready" as const,
    channels: channels.map((channel) => ({
      ...channel,
      name: channel.id,
      creator: viewer,
    })),
  };
  const session = {
    viewer,
    snapshotRead: vi.fn(async () => (head ? [head] : [])),
    configArtifactWriter: { sign, publish },
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
    },
  } as unknown as RelaySession;
  const snapshot = { status: "ready", generation: 1, scope: "s", session };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  return { relay, session, sign, publish };
}

it("links the pull request to the Solo chat it was opened from, and unlinks it", async () => {
  const { relay, sign, publish } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  const pulls = fakePulls();
  const { rerender } = render(
    <SoloPullLink
      relay={relay}
      pullsFor={() => pulls}
      channelId={chat}
      url={pull}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Link to this chat" }),
  );
  expect(await screen.findByRole("button", { name: "Unlink" })).toBeEnabled();
  expect(pulls.linked).toHaveBeenCalledWith(chat, pull);
  expect(sign).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
  expect(
    screen.getByText("Shown in the sidebar for this chat."),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
  expect(
    await screen.findByRole("button", { name: "Link to this chat" }),
  ).toBeInTheDocument();
  expect(pulls.linked).toHaveBeenLastCalledWith(chat, null);

  // A team channel is not a Solo chat; nothing to link.
  rerender(
    <SoloPullLink
      relay={relay}
      pullsFor={() => pulls}
      channelId={team}
      url={pull}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});

it("gives agents a github_link_pr tool for the Solo chat they work in", async () => {
  const { relay, sign } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  let tool: AddedTool | undefined;
  const inject = vi.fn();
  apply({
    host: {},
    panels: { register: () => {} },
    conversation: {
      registerChatIcon: () => {},
      registerChatMenu: () => {},
      registerMessageAction: () => {},
      registerLink: () => {},
    },
    relay,
    agents: {
      addTool: (added: AddedTool) => {
        if (added.name === "github_link_pr") tool = added;
      },
      relay: () => relay,
    },
    inject,
    provide: () => {},
  } as never);
  const client = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
  } as BuzzClient;
  expect(inject).toHaveBeenCalledWith(
    ["agents", "host", "navigation"],
    expect.any(Function),
  );
  expect(tool?.name).toBe("github_link_pr");
  await expect(
    tool?.call(client, { channel: chat }, { url: "https://github.com/block" }),
  ).rejects.toThrow("url must be a GitHub pull request URL");
  await expect(
    tool?.call(client, { channel: team }, { url: pull }),
  ).rejects.toThrow("Only a Solo chat can be linked");
  expect(await tool?.call(client, { channel: chat }, { url: pull })).toBe(
    `Linked ${pull}. The sidebar shows its state for this chat.`,
  );
  expect(sign).toHaveBeenCalledOnce();
  expect(await tool?.call(client, { channel: chat }, { unlink: true })).toBe(
    "Unlinked this chat's pull request.",
  );
});

it("offers unlink only for a linked owned chat and clears the link after publication", async () => {
  const { session: baseSession, publish } = relayWith([
    { id: chat, channelType: "solo" },
  ]);
  const pulls = fakePulls({ [chat]: { url: pull } });
  const session = {
    ...baseSession,
    snapshotRead: vi.fn(async () => [
      {
        kind: 45010,
        id: "a".repeat(64),
        content: JSON.stringify({ url: pull }),
        tags: [["type", "buzz.solo.pr"]],
      },
    ]),
  } as unknown as RelaySession;
  render(
    <MenuRoot open>
      <MenuPopup>
        <SoloPullMenu session={session} pulls={pulls} channelId={chat} />
      </MenuPopup>
    </MenuRoot>,
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Unlink pull request" }),
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(pulls.linked).toHaveBeenCalledWith(chat, null);
  expect(
    screen.queryByRole("menuitem", { name: "Unlink pull request" }),
  ).not.toBeInTheDocument();
});

it("hides unlink for unlinked chats and team channels", () => {
  const { session } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  render(
    <MenuRoot open>
      <MenuPopup>
        <SoloPullMenu session={session} pulls={fakePulls()} channelId={chat} />
        <SoloPullMenu
          session={session}
          pulls={fakePulls({ [team]: { url: pull } })}
          channelId={team}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  expect(
    screen.queryByRole("menuitem", { name: "Unlink pull request" }),
  ).not.toBeInTheDocument();
});

it("keeps unlink visible but disabled when the connection cannot sign link updates", async () => {
  const { session: base } = relayWith([{ id: chat, channelType: "solo" }]);
  const session = {
    ...base,
    configArtifactWriter: undefined,
  } as unknown as RelaySession;
  render(
    <MenuRoot open>
      <MenuPopup>
        <SoloPullMenu
          session={session}
          pulls={fakePulls({ [chat]: { url: pull } })}
          channelId={chat}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const action = await screen.findByRole("menuitem", {
    name: "Unlink pull request",
  });
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(action).toHaveAttribute(
    "title",
    "Unlinking needs a native desktop relay connection.",
  );
});

it("opens the current linked PR from the header and removes the shortcut on unlink", async () => {
  const pulls = fakePulls({
    [chat]: { url: pull, state: { state: "merged" } },
  });
  const open = vi.fn(() => true);
  const { rerender } = render(
    <SessionPullLauncher
      pulls={pulls}
      channelId={chat}
      open={open}
      canOpen={() => true}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open linked pull request, merged" }),
  );
  expect(open).toHaveBeenCalledWith(pull);
  expect(screen.getByRole("button").querySelector("[data-tone]")).toBeNull();
  act(() => pulls.linked(chat, `${pull}8`));
  await userEvent.click(
    screen.getByRole("button", { name: "Open linked pull request" }),
  );
  expect(open).toHaveBeenLastCalledWith(`${pull}8`);
  rerender(
    <SessionPullLauncher
      pulls={pulls}
      channelId={chat}
      open={open}
      canOpen={() => false}
    />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
  act(() => pulls.linked(chat, null));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("keeps the linked PR shortcut usable in browser mode and switches back live", () => {
  setOpenGitHubLinksInBuzz(false);
  const open = vi.fn(() => true);
  render(
    <SessionPullLauncher
      pulls={fakePulls({ [chat]: { url: pull } })}
      channelId={chat}
      open={open}
      canOpen={() => true}
    />,
  );
  const link = screen.getByRole("link", { name: "Open linked pull request" });
  expect(link).toHaveAttribute("href", pull);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(open).not.toHaveBeenCalled();
  act(() => setOpenGitHubLinksInBuzz(true));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open linked pull request" }),
  ).toBeEnabled();
});

it("only mounts the PR shortcut for a Solo in the current community", () => {
  const { relay, session } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  const state = { ...relay.snapshot(), viewer };
  const activeRelay = { ...relay, snapshot: () => state };
  const pullsFor = vi.fn(() => fakePulls({ [chat]: { url: pull } }));
  const context = {
    scope: "s",
    viewer,
    channelId: team,
    channelName: "Chat",
    relayUrl: "wss://example.com",
  };
  const props = {
    relay: activeRelay,
    pullsFor,
    context,
    pressed: false,
    available: () => true,
    open: () => true,
    canOpen: () => true,
    toggle() {},
  };
  const view = render(<SoloPullLauncher {...props} />);
  expect(pullsFor).not.toHaveBeenCalled();
  view.rerender(
    <SoloPullLauncher
      {...props}
      context={{ ...context, channelId: chat, scope: "another" }}
    />,
  );
  expect(pullsFor).not.toHaveBeenCalled();
  view.rerender(
    <SoloPullLauncher {...props} context={{ ...context, channelId: chat }} />,
  );
  expect(pullsFor).toHaveBeenCalledWith(session);
  expect(
    screen.getByRole("button", { name: "Open linked pull request" }),
  ).toBeVisible();
});

function pullMessage(content = pull): ChannelMessage {
  return { id: "message", channelId: chat, content } as ChannelMessage;
}

function messagePullMenu(
  value: ReturnType<typeof relayWith>,
  pulls: SoloPulls,
  message = pullMessage(),
) {
  return (
    <ToastProvider>
      <MenuRoot open>
        <MenuPopup>
          <ChatPullMessageAction
            {...value}
            message={message}
            pulls={pulls}
            close={() => {}}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>
  );
}

it("lists each distinct PR in a message and replaces or unlinks the chat's association with browser opening selected", async () => {
  setOpenGitHubLinksInBuzz(false);
  const value = relayWith([{ id: chat, channelType: "solo" }]);
  const pulls = fakePulls();
  const other = "https://github.com/block/buzz-app/pull/8";
  render(
    messagePullMenu(
      value,
      pulls,
      pullMessage(`${pull}\n${other}\n[review](${pull}#discussion_r1)`),
    ),
  );
  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Link buzz-app#7 to chat" }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Unlink buzz-app#7 from chat",
    }),
  ).toBeEnabled();
  expect(value.publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      content: JSON.stringify({ version: 1, url: pull }),
    }),
    expect.anything(),
  );
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Link buzz-app#8 to chat" }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Unlink buzz-app#8 from chat",
    }),
  ).toBeEnabled();
  expect(
    screen.getByRole("menuitem", { name: "Link buzz-app#7 to chat" }),
  ).toBeEnabled();
  expect(pulls.get(chat)?.url).toBe(other);
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Unlink buzz-app#8 from chat" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Link buzz-app#8 to chat" }),
  ).toBeEnabled();
  expect(pulls.get(chat)).toBeUndefined();
  expect(value.publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      content: JSON.stringify({ version: 1, url: null }),
    }),
    expect.anything(),
  );
});

it("keeps a failed message-menu save retryable without changing the linked PR", async () => {
  const value = relayWith([{ id: chat, channelType: "solo" }]);
  const pulls = fakePulls();
  value.publish.mockRejectedValueOnce(new Error("Save refused"));
  render(messagePullMenu(value, pulls));
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Link PR to chat" }),
  );
  expect(await screen.findByText("Save refused")).toBeVisible();
  expect(pulls.get(chat)).toBeUndefined();
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Link PR to chat" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Unlink PR from chat" }),
  ).toBeEnabled();
  expect(pulls.get(chat)?.url).toBe(pull);
});

it("prevents a second message-menu save while publication is pending", async () => {
  const value = relayWith([{ id: chat, channelType: "solo" }]);
  const pulls = fakePulls();
  let complete!: () => void;
  const gate = new Promise<string>((resolve) => {
    complete = () => resolve("");
  });
  value.publish.mockImplementationOnce(() => gate);
  render(messagePullMenu(value, pulls));
  const action = screen.getByRole("menuitem", { name: "Link PR to chat" });
  try {
    fireEvent.click(action);
    await waitFor(() =>
      expect(action).toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(action);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(pulls.get(chat)).toBeUndefined();
    await act(async () => {
      complete();
      await gate;
    });
    expect(
      await screen.findByRole("menuitem", { name: "Unlink PR from chat" }),
    ).toBeEnabled();
  } finally {
    complete();
  }
});

it("rejects stale, disconnected and cached message-menu clicks before signing", () => {
  const value = relayWith([{ id: chat, channelType: "solo" }]);
  const pulls = fakePulls();
  render(messagePullMenu(value, pulls));
  const action = screen.getByRole("menuitem", { name: "Link PR to chat" });
  const snapshot = value.relay.snapshot();
  const initial = { ...snapshot };
  for (const change of [
    { cached: true },
    { status: "disconnected" },
    { session: { ...value.session } },
  ]) {
    Object.assign(snapshot, initial, { cached: undefined }, change);
    fireEvent.click(action);
  }
  expect(value.sign).not.toHaveBeenCalled();
  expect(value.publish).not.toHaveBeenCalled();
});

it("offers message-menu PR actions only for owned writable Solo chats with link storage", () => {
  for (const change of [
    { channelType: "stream" },
    { channelType: "forum" },
    { channelType: "dm" },
    { creator: "another-viewer" },
    { archived: true },
    { readOnly: true },
  ]) {
    const value = relayWith([{ id: chat, channelType: "solo" }]);
    const channel = value.session.channels.list().channels[0];
    if (!channel) throw new Error("Missing test chat");
    Object.assign(channel, change);
    expect(hasChatPullAction(pullMessage(), value.session)).toBe(false);
    const view = render(messagePullMenu(value, fakePulls()));
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    view.unmount();
  }
  const { session } = relayWith([{ id: chat, channelType: "solo" }]);
  expect(hasChatPullAction(pullMessage(), session)).toBe(true);
  expect(
    hasChatPullAction(
      pullMessage("https://github.com/block/buzz-app/issues/7"),
      session,
    ),
  ).toBe(false);
  expect(
    hasChatPullAction(pullMessage(), {
      ...session,
      configArtifactWriter: undefined,
    }),
  ).toBe(false);
  expect(
    hasChatPullAction(pullMessage(), { ...session, snapshotRead: undefined }),
  ).toBe(false);
});
