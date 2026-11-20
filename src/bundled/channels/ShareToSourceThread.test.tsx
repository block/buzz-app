// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { linkedSourceKey } from "../../features/solo/linked-chat";
import { parseOpenTarget } from "../../features/navigation/targets";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { readView, writeView } from "../../shared/view-state";
import {
  ShareToSourceThread,
  canShareToSourceThread,
} from "./ShareToSourceThread";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const viewer = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64),
  answer = "d".repeat(64),
  other = "e".repeat(64);
const scope = `https://relay.test:${viewer}`;
const session = { ...owner.session, viewer, scope };
const message = {
  id: answer,
  channelId: "solo-chat",
  delivery: "seen" as const,
  authorId: "f".repeat(64),
  content: "Here is what I found",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const threadDraft = `draft:design:thread:${root}`;
const startedFrom = (link: string) =>
  writeView(scope, linkedSourceKey("solo-chat"), {
    channelId: "design",
    link,
  });

async function share() {
  const open = vi.fn<Navigation["open"]>(async (target) => {
    // The real controller refuses targets its parser rejects.
    parseOpenTarget(target);
    return { status: "opened" };
  });
  render(
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <ShareToSourceThread
            session={session}
            navigation={{ ...({} as Navigation), open }}
            message={message}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Share to original thread" }),
  );
  return open;
}

it("matches only chats started from a message on this device", () => {
  expect(canShareToSourceThread(message, session)).toBe(false);
  startedFrom("buzz://channel/design");
  expect(canShareToSourceThread(message, session)).toBe(false);
  startedFrom(`buzz://message?channel=design&id=${root}`);
  expect(canShareToSourceThread(message, session)).toBe(true);
  expect(
    canShareToSourceThread({ ...message, delivery: "sending" }, session),
  ).toBe(false);
});

it("attaches the message to the source thread's draft and opens that thread", async () => {
  startedFrom(`buzz://message?channel=design&id=${reply}&thread=${root}`);
  writeView(scope, threadDraft, "Half typed");
  const open = await share();
  expect(readView(scope, threadDraft, null)).toEqual({
    text: "Half typed",
    recipients: [],
    forward: {
      version: 1,
      origin: "https://relay.test",
      channelId: "solo-chat",
      id: answer,
    },
  });
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.test", viewer },
    channelId: "design",
    messageId: reply,
    threadRootId: root,
  });
});

it("keeps a different forward already waiting in that thread's draft", async () => {
  startedFrom(`buzz://message?channel=design&id=${root}`);
  const waiting = {
    text: "",
    recipients: [],
    forward: {
      version: 1,
      origin: "https://relay.test",
      channelId: "elsewhere",
      id: other,
    },
  };
  writeView(scope, threadDraft, waiting);
  const open = await share();
  expect(
    await screen.findByText(/already has a forwarded message/),
  ).toBeInTheDocument();
  expect(readView(scope, threadDraft, null)).toEqual(waiting);
  expect(open).not.toHaveBeenCalled();
});
