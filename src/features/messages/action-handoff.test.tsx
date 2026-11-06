// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StartLinkedChat } from "../../bundled/channels/StartLinkedChat";
import { MenuGroup, MenuItem } from "../../shared/design-system/ui/Menu";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { MessageActionBar } from "./MessageActionBar";
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

it("activates the requested contribution in the requesting bar's own menu, not another rendering's", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const bar = (
    handler: () => void,
    label: string,
    request?: { id: number; activate: number },
  ) => (
    <MessageActionBar
      messageId="same-message"
      copyText={() => label}
      openRequest={request}
      overflowItems={
        <MenuGroup data-contribution={1}>
          <MenuItem onClick={handler}>{label}</MenuItem>
        </MenuGroup>
      }
    />
  );
  const view = (request?: { id: number; activate: number }) => (
    <ToastProvider>
      {bar(first, "First rendering")}
      {bar(second, "Second rendering", request)}
    </ToastProvider>
  );
  const rendered = render(view());
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "More message actions",
    })[0] as HTMLElement,
  );
  await screen.findByRole("menuitem", { name: "First rendering" });
  rendered.rerender(view({ id: 1, activate: 1 }));
  await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  expect(first).not.toHaveBeenCalled();
});
