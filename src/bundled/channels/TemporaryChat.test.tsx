// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import { parseOpenTarget } from "../../features/navigation/targets";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import { createRelaySession } from "../../features/relay/session";
import {
  TEMPORARY_LABELS,
  openTemporaryChat,
  showTemporaryChat,
} from "../../features/solo/temporary-chat";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { readView, writeView } from "../../shared/view-state";
import {
  PostBackMenuItem,
  TemporaryChatMarker,
  canPostBack,
} from "./TemporaryChat";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const viewer = "a".repeat(64);
const agent = "b".repeat(64);
const root = "c".repeat(64);
const reply = "d".repeat(64);
const answerId = "e".repeat(64);
const sourceChannel = "11111111-1111-4111-8111-111111111111";
const chatId = "22222222-2222-4222-8222-222222222222";
const scope = `https://relay.test:${viewer}`;
const sourceLink = `buzz://message?channel=${sourceChannel}&id=${reply}&thread=${root}`;

const chat: ChannelSummary = {
  id: chatId,
  name: "About: launch checklist",
  channelType: "solo",
  creator: viewer,
  members: [viewer, agent],
  labels: [...TEMPORARY_LABELS],
  unlisted: true,
  description: `Temporary chat about ${sourceLink}. Post back there only when asked.`,
};

const answer: ChannelMessage = {
  id: answerId,
  channelId: chatId,
  delivery: "seen",
  authorId: agent,
  content: "Three items are still open.",
  createdAt: 10,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};

function makeSession(channel: ChannelSummary | undefined = chat) {
  const listResult = {
    status: "ready" as const,
    channels: channel ? [channel] : [],
  };
  return {
    ...owner.session,
    viewer,
    scope,
    channels: {
      ...owner.session.channels,
      list: () => listResult,
      get: (id: string) => (id === channel?.id ? channel : undefined),
    },
    messages: {
      ...owner.session.messages,
      forwardProblem: () => undefined,
    },
  };
}

async function clickPostBack(
  session: ReturnType<typeof makeSession>,
  currentTarget: ReturnType<Navigation["snapshot"]>["entry"]["target"],
) {
  const open = vi.fn<Navigation["open"]>(async (target) => {
    parseOpenTarget(target);
    return { status: "opened" };
  });
  const close = vi.fn();
  const navigation = {
    open,
    snapshot: () => ({ entry: { target: currentTarget } }),
  } as unknown as Navigation;
  render(
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <PostBackMenuItem
            message={answer}
            session={session}
            navigation={navigation}
            close={close}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Post to thread" }),
  );
  return { open, close };
}

it("offers Post to thread only on delivered agent replies in the viewer's temporary chat", () => {
  const session = makeSession();
  expect(canPostBack(answer, session)).toBe(true);
  expect(canPostBack({ ...answer, authorId: viewer }, session)).toBe(false);
  expect(canPostBack({ ...answer, delivery: "sending" }, session)).toBe(false);
  expect(canPostBack({ ...answer, content: "   " }, session)).toBe(false);
  expect(canPostBack(answer, makeSession({ ...chat, labels: [] }))).toBe(false);
});

it("stages the reply as an attributed forward card in the source thread without sending, closes the sheet and opens the thread", async () => {
  const session = makeSession();
  const draftKey = `draft:${sourceChannel}:thread:${root}`;
  writeView(scope, draftKey, "Quick update:");
  showTemporaryChat(session, {
    chatId,
    source: {
      channelId: sourceChannel,
      messageId: reply,
      rootId: root,
      link: sourceLink,
    },
  });
  const { open, close } = await clickPostBack(session, {
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.test", viewer },
    channelId: sourceChannel,
  });
  expect(readView(scope, draftKey, null)).toEqual({
    text: "Quick update:",
    recipients: [],
    forward: {
      version: 1,
      origin: "https://relay.test",
      channelId: chatId,
      id: answerId,
    },
  });
  expect(openTemporaryChat(session)).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.test", viewer },
    channelId: sourceChannel,
    messageId: reply,
    threadRootId: root,
  });
});

it("stays on the already-open inline thread when posting back from over it", async () => {
  const session = makeSession();
  const draftKey = `draft:${sourceChannel}:thread:${root}`;
  const { open, close } = await clickPostBack(session, {
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.test", viewer },
    channelId: sourceChannel,
    inline: root,
  });
  expect(readView(scope, draftKey, null)).toEqual({
    text: "",
    recipients: [],
    forward: {
      version: 1,
      origin: "https://relay.test",
      channelId: chatId,
      id: answerId,
    },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it("keeps the reopen marker visible for archived temporary chats and allows posting back from them", async () => {
  const archived: ChannelSummary = { ...chat, archived: true };
  const session = makeSession(archived);
  expect(canPostBack(answer, session)).toBe(true);
  render(
    <TemporaryChatMarker
      message={{ ...answer, id: reply, channelId: sourceChannel }}
      session={session}
    />,
  );
  const marker = screen.getByRole("button", {
    name: "Your temporary chat · Archived",
  });
  await userEvent.setup().click(marker);
  expect(openTemporaryChat(session)?.chatId).toBe(chatId);
});
