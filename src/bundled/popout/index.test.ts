import { afterEach, expect, it, vi } from "vitest";
import { messageActionRequests } from "../../features/messages/action-requests";
import { soloAccessRequests } from "../../features/solo/access-requests";
import { apply } from "./index";

const h = vi.hoisted(() => ({
  options: undefined as
    | undefined
    | {
        handoff(target: unknown, messageId: string, action: unknown): void;
        openActivity(activityTarget: string, target: unknown): void;
        openMembers(channelId: string, solo: boolean): void;
      },
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../../features/popout/window", () => ({
  createPopoutWindows: (_relay: unknown, options: typeof h.options) => {
    h.options = options;
    return {
      notices: { snapshot: () => [], subscribe: () => () => {} },
      held: () => false,
      subscribeHeld: () => () => {},
      dispose: async () => {},
    };
  },
}));
afterEach(() => {
  messageActionRequests.clear();
  soloAccessRequests.clear();
});

const target = { channelId: "channel", threadRootId: "b".repeat(64) };
const activity = `buzz:profile?agent=${"c".repeat(64)}&tab=activity`;
const action = { key: "plugin:remind", revision: "1", id: "remind" };

function setup() {
  let connection = {
    viewer: "a".repeat(64),
    origin: "https://relay.test",
    scope: "https://relay.test:viewer",
    session: {},
  };
  const open = vi.fn();
  const requestOpen = vi.fn();
  apply({
    relay: { snapshot: () => connection },
    conversation: {
      actions: {},
      registerAccessory: vi.fn(),
      registerMessageAction: vi.fn(),
      registerTabAction: vi.fn(),
    },
    navigation: { open },
    panels: { requestOpen },
    communityReader: {},
    effect: vi.fn(),
  } as never);
  return {
    open,
    requestOpen,
    switchCommunity: () => {
      connection = { ...connection, scope: "https://other.test:viewer" };
    },
    replaceSession: () => {
      connection = { ...connection, session: {} };
    },
  };
}

it("continues into the activity panel only after the navigation opened in the same connection", async () => {
  let x = setup();
  x.open.mockResolvedValue({ status: "opened" });
  h.options?.openActivity(activity, target);
  await Promise.resolve();
  expect(x.requestOpen).toHaveBeenCalledWith({
    target: activity,
    channelId: target.channelId,
    rootId: target.threadRootId,
  });

  x = setup();
  x.open.mockResolvedValue({ status: "failed", reason: "not-found" });
  h.options?.openActivity(activity, target);
  await Promise.resolve();
  expect(x.requestOpen).not.toHaveBeenCalled();

  x = setup();
  let settle!: (value: unknown) => void;
  x.open.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  h.options?.openActivity(activity, target);
  x.switchCommunity();
  settle({ status: "opened" });
  await Promise.resolve();
  expect(x.requestOpen).not.toHaveBeenCalled();

  x = setup();
  x.open.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  h.options?.openActivity(activity, target);
  x.replaceSession();
  settle({ status: "opened" });
  await Promise.resolve();
  expect(x.requestOpen).not.toHaveBeenCalled();
});

it("requests the handed-off action for the row only after main opened the message in the same connection", async () => {
  const messageId = "d".repeat(64);
  let x = setup();
  x.open.mockResolvedValue({ status: "opened" });
  h.options?.handoff(target, messageId, action);
  await Promise.resolve();
  expect(messageActionRequests.snapshot()).toEqual({
    session: expect.anything(),
    scope: "https://relay.test:viewer",
    channelId: target.channelId,
    messageId,
    key: action.key,
    revision: action.revision,
  });
  messageActionRequests.clear();

  x = setup();
  x.open.mockResolvedValue({ status: "cancelled" });
  h.options?.handoff(target, messageId, action);
  await Promise.resolve();
  expect(messageActionRequests.snapshot()).toBeUndefined();

  x = setup();
  let settle!: (value: unknown) => void;
  x.open.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  h.options?.handoff(target, messageId, action);
  x.switchCommunity();
  settle({ status: "opened" });
  await Promise.resolve();
  expect(messageActionRequests.snapshot()).toBeUndefined();

  x = setup();
  x.open.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  h.options?.handoff(target, messageId, action);
  x.replaceSession();
  settle({ status: "opened" });
  await Promise.resolve();
  expect(messageActionRequests.snapshot()).toBeUndefined();
});

it("opens members as main's header does: the Members panel for a channel, and a Solo chat's Share access through its header after main shows the chat", async () => {
  let x = setup();
  x.open.mockResolvedValue({ status: "opened" });
  h.options?.openMembers("channel", false);
  expect(x.open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "channel",
      panel: "members",
    }),
  );
  expect(soloAccessRequests.snapshot()).toBeUndefined();

  x = setup();
  x.open.mockResolvedValue({ status: "opened" });
  h.options?.openMembers("solo", true);
  expect(x.open).toHaveBeenCalledWith(
    expect.not.objectContaining({ panel: "members" }),
  );
  await Promise.resolve();
  expect(soloAccessRequests.snapshot()).toEqual({
    session: expect.anything(),
    scope: "https://relay.test:viewer",
    channelId: "solo",
  });
  soloAccessRequests.clear();

  // A navigation that did not open, or one whose session was replaced
  // meanwhile, hands nothing to the header.
  x = setup();
  x.open.mockResolvedValue({ status: "cancelled" });
  h.options?.openMembers("solo", true);
  await Promise.resolve();
  expect(soloAccessRequests.snapshot()).toBeUndefined();
  x = setup();
  let settle!: (value: unknown) => void;
  x.open.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  h.options?.openMembers("solo", true);
  x.replaceSession();
  settle({ status: "opened" });
  await Promise.resolve();
  expect(soloAccessRequests.snapshot()).toBeUndefined();
});
