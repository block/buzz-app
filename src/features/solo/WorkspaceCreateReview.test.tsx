// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agents, WorkspaceCreateRequest } from "../agents/service";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { WorkspaceCreateReview } from "./WorkspaceCreateReview";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const request: WorkspaceCreateRequest = {
  id: "0b5c3f5e-9a51-4c43-9a4e-2f6f2f6c1a11",
  requester: "bot",
  requesterName: "Robo",
  owner: "owner",
  community: "https://relay.example.test",
  name: "Repo",
  workspace: {
    folders: ["/repo"],
    worktree: { location: "/work", baseBranch: "main" },
    canvas: "Ship.",
  },
  chats: ["chat-1", "chat-2"],
};
const requests = [request];

const solo = (id: string, extra: Partial<ChannelSummary> = {}) =>
  ({ id, channelType: "solo", archived: false, ...extra }) as ChannelSummary;
const ownChats = [solo("chat-1"), solo("chat-2")];

function mount(
  scope = "https://relay.example.test:owner",
  fail = new Set<string>(),
  channels: { status: string; channels: ChannelSummary[] } = {
    status: "ready",
    channels: ownChats,
  },
) {
  const dismiss = vi.fn();
  const agents = {
    subscribe: () => () => {},
    workspaceCreateRequests: () => requests,
    dismissWorkspaceCreate: dismiss,
  } as unknown as Agents;
  const calls: string[] = [];
  const save = vi.fn(async () => {});
  const session = {
    scope,
    viewer: "owner",
    channels: { ensureList: () => {}, list: () => channels },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries: [] }),
      save,
    },
    soloPreferences: {
      createSection: vi.fn(
        async ({ id, name }: { id: string; name: string }) => {
          calls.push(`create ${id} ${name}`);
        },
      ),
      assign: vi.fn(async (chat: string) => {
        if (fail.has(chat)) {
          fail.delete(chat);
          throw new Error("Not confirmed");
        }
        calls.push(`file ${chat}`);
      }),
    },
  } as unknown as RelaySession;
  render(<WorkspaceCreateReview agents={agents} session={session} />);
  return { dismiss, calls, save };
}

it("prefills the proposal and files its chats once the owner creates it", async () => {
  const { dismiss, calls, save } = mount();
  const dialog = screen.getByRole("dialog", { name: "New workspace" });
  expect(dialog).toHaveTextContent(
    "Robo proposed this workspace and 2 chats to file in it.",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Repo");
  expect(dialog).toHaveTextContent("/repo");
  expect(calls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith(request.id));
  expect(calls).toEqual([
    `create ${request.id} Repo`,
    "file chat-1",
    "file chat-2",
  ]);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      canvas: expect.stringContaining("Ship."),
    }),
    undefined,
    false,
    undefined,
    expect.anything(),
  );
});

it("retries a failed filing in the same workspace", async () => {
  const { dismiss, calls, save } = mount(undefined, new Set(["chat-2"]));
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not confirmed");
  expect(dismiss).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith(request.id));
  expect(calls).toEqual([
    `create ${request.id} Repo`,
    "file chat-1",
    `create ${request.id} Repo`,
    "file chat-1",
    "file chat-2",
  ]);
  expect(save).toHaveBeenCalledOnce();
});

it("waits for the proposing owner's community", () => {
  mount("https://other.example.test:owner");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each([
  [
    "a regular channel",
    [solo("chat-1"), solo("chat-2", { channelType: "stream" })],
  ],
  ["an unknown chat", [solo("chat-1")]],
])("saves nothing when a proposed chat is %s", async (_, channels) => {
  const { dismiss, calls, save } = mount(undefined, undefined, {
    status: "ready",
    channels,
  });
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Chat chat-2 isn't one of your Solo chats in this community.",
  );
  expect(calls).toEqual([]);
  expect(save).not.toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalled();
});

it("files a Solo chat shared with the owner", async () => {
  const shared = solo("chat-2", {
    readOnly: true,
    viewerRole: "guest",
    members: ["someone", "owner"],
  } as Partial<ChannelSummary>);
  const { dismiss, calls } = mount(undefined, undefined, {
    status: "ready",
    channels: [solo("chat-1"), shared],
  });
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith(request.id));
  expect(calls).toContain("file chat-2");
});

it("waits for the chat list before saving", async () => {
  const { calls } = mount(undefined, undefined, {
    status: "loading",
    channels: [],
  });
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your chats are still loading.",
  );
  expect(calls).toEqual([]);
});
