// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StartLinkedChat } from "../../bundled/channels/StartLinkedChat";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import { messageActionRequests } from "./action-requests";
import { MessageRow } from "./MessageRow";

afterEach(() => {
  messageActionRequests.clear();
  cleanup();
  localStorage.clear();
});

it("activates a handed-off Start Solo chat through its own menu item, opening the draft", async () => {
  const owner = createRelaySession(null);
  const viewer = "a".repeat(64);
  const scope = `https://relay.test:${viewer}`;
  const channelList = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        name: "Channel",
        channelType: "stream" as const,
        members: [viewer],
      },
    ],
  };
  const session = {
    ...owner.session,
    viewer,
    scope,
    channelWrites: { ...owner.session.channelWrites, available: true },
    channels: { ...owner.session.channels, list: () => channelList },
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigation = {
    open,
    snapshot: () => ({ attempt: { id: "one" } }),
  } as never;
  const row = {
    id: "b".repeat(64),
    channelId: "channel",
    authorId: viewer,
    content: "Message",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const action = {
    id: "start-solo-chat",
    key: "channels/start-solo-chat",
    pluginId: "channels",
    revision: "1",
    title: "Start Solo chat",
    placement: "menu" as const,
    matches: () => true,
    component: () => (
      <StartLinkedChat
        session={session}
        navigation={navigation}
        channelId="channel"
        message={row}
      />
    ),
  };
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  const entries = [action];
  try {
    render(
      <ToastProvider>
        <MessageRow
          row={row}
          session={session}
          scope={scope}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          extensions={{
            tools: empty,
            inline: empty,
            actions: { snapshot: () => entries, subscribe: () => () => {} },
          }}
        />
      </ToastProvider>,
    );
    act(() =>
      messageActionRequests.request({
        session,
        scope,
        channelId: row.channelId,
        messageId: row.id,
        key: action.key,
        revision: action.revision,
      }),
    );
    // The contribution's own item ran: its draft navigation was requested
    // without anyone choosing the action again.
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(open.mock.calls[0])).toContain("linked");
    expect(messageActionRequests.snapshot()).toBeUndefined();
  } finally {
    owner.dispose();
  }
});
