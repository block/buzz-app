// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import {
  NameConversation,
  canNameConversation,
  canStartConversationFrom,
} from "./NameConversation";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(cleanup);
const viewer = "a".repeat(64),
  tom = "b".repeat(64),
  molly = "c".repeat(64),
  cut = "d".repeat(64);
const scope = `https://relay.test:${viewer}`;
const people = new Map([
  [tom, { pubkey: tom, name: "Tom" }],
  [molly, { pubkey: molly, name: "Molly" }],
]);
const dm: ChannelSummary = {
  id: "dm-1",
  name: "Tom, Molly",
  channelType: "dm",
  participants: [tom, molly],
};

function harness(nameable = true) {
  const name = vi.fn(async (id: string) => id);
  const move = vi.fn(async () => ({ channelId: "named", created: true }));
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  const session = {
    ...owner.session,
    viewer,
    scope,
    profiles: {
      ...owner.session.profiles,
      snapshot: () => people,
      subscribe: () => () => {},
    },
    channels: { ...owner.session.channels, get: () => dm },
    directMessages: {
      ...owner.session.directMessages,
      nameable,
      name,
      move,
    },
  } as unknown as typeof owner.session;
  const navigation = { open } as unknown as Navigation;
  return { session, navigation, name, move, open };
}

const message = (overrides: Partial<ChannelMessage> = {}) =>
  ({
    id: cut,
    channelId: dm.id,
    delivery: "seen",
    authorId: tom,
    content: "Kickoff",
    createdAt: 1_700_000_000,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...overrides,
  }) as ChannelMessage;

it("is offered only on a DM, and from a top-level message", () => {
  const { session } = harness();
  expect(canNameConversation(session, dm)).toBe(true);
  expect(canNameConversation(session, { ...dm, channelType: "stream" })).toBe(
    false,
  );
  expect(canNameConversation(harness(false).session, dm)).toBe(false);
  expect(canStartConversationFrom(message(), session)).toBe(true);
  expect(
    canStartConversationFrom(
      message({ threadRootId: "e".repeat(64) }),
      session,
    ),
  ).toBe(false);
});

it("names the DM in place, warning whose next message starts fresh", async () => {
  const { session, navigation, name, move, open } = harness();
  const close = vi.fn();
  render(
    <NameConversation
      session={session}
      navigation={navigation}
      channel={dm}
      close={close}
    />,
  );
  expect(
    screen.getByText(
      "This conversation moves to the new conversation. Your next message to Tom and Molly starts fresh.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Add a name.")).toBeInTheDocument();
  expect(name).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Name"), "Site refresh");
  expect(
    screen.getByText(
      "This conversation moves to “Site refresh”. Your next message to Tom and Molly starts fresh.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(name).toHaveBeenCalledWith(
      dm.id,
      { name: "Site refresh" },
      expect.any(AbortSignal),
    ),
  );
  expect(move).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("moves from a message into the new conversation and opens it", async () => {
  const { session, navigation, name, move, open } = harness();
  render(
    <NameConversation
      session={session}
      navigation={navigation}
      channel={dm}
      from={message()}
      close={() => {}}
    />,
  );
  expect(
    screen.getByText(
      "Messages from here on move to the new conversation, with everyone here. Earlier messages stay in this DM.",
    ),
  ).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Name"), "Launch");
  await userEvent.click(screen.getByRole("button", { name: "Move messages" }));
  await waitFor(() =>
    expect(move).toHaveBeenCalledWith(
      dm.id,
      { cut, name: "Launch" },
      expect.any(AbortSignal),
    ),
  );
  expect(name).not.toHaveBeenCalled();
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
});

it("keeps the dialog open and says why when the move is refused", async () => {
  const { session, navigation, move } = harness();
  move.mockRejectedValueOnce(
    new Error("There are no messages from today to move."),
  );
  render(
    <NameConversation
      session={session}
      navigation={navigation}
      channel={dm}
      from={message()}
      close={() => {}}
    />,
  );
  await userEvent.type(screen.getByLabelText("Name"), "Launch");
  await userEvent.click(screen.getByRole("button", { name: "Move messages" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "There are no messages from today to move.",
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
