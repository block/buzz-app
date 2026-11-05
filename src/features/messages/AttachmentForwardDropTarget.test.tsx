// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { useAttachmentForwardDropTarget } from "./AttachmentForwardDropTarget";
import type { ReactNode } from "react";

function AttachmentForwardDropTarget({
  channel,
  session,
  children,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  children: ReactNode;
}) {
  const target = useAttachmentForwardDropTarget(channel, session);
  return (
    <div {...target.props}>
      {children}
      {target.overlay}
    </div>
  );
}
import {
  ATTACHMENT_FORWARD_MIME,
  attachmentForwardPayload,
} from "./attachment-forwarding";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const attachment = {
  url: "https://relay.test/media/photo.png",
  kind: "image" as const,
};
const source: ChannelMessage = {
  id: "source",
  channelId: "origin",
  authorId: "author",
  content: attachment.url,
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [attachment],
  reactions: [],
  replyCount: 0,
};
const channel: ChannelSummary = {
  id: "destination",
  name: "Design",
  channelType: "stream",
} as ChannelSummary;

function setup() {
  const send = vi.fn();
  const session = {
    channels: {
      window: vi.fn(() => ({ rows: [source] })),
    },
    thread: vi.fn(() => ({
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ targetStatus: "unavailable" }),
      dispose: vi.fn(),
    })),
    messages: { resendAttachments: send },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <AttachmentForwardDropTarget channel={channel} session={session}>
        <button type="button">Design</button>
      </AttachmentForwardDropTarget>
    </ToastProvider>,
  );
  const dataTransfer = {
    types: [ATTACHMENT_FORWARD_MIME],
    dropEffect: "move",
    getData: vi.fn(() => attachmentForwardPayload(source, [attachment])),
  };
  return { session, send, dataTransfer };
}

it("resends the dragged attachment to the dropped channel", async () => {
  const { send, dataTransfer } = setup();
  fireEvent.dragEnter(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  expect(await screen.findByText("Send here")).toBeInTheDocument();
  fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  expect(send).toHaveBeenCalledWith("destination", source, [attachment]);
  expect(
    await screen.findByText("Attachment sent to Design"),
  ).toBeInTheDocument();
});

it("reports when the source row is no longer loaded", async () => {
  const { session, send, dataTransfer } = setup();
  vi.mocked(session.channels.window).mockReturnValue({ rows: [] } as never);
  fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  expect(send).not.toHaveBeenCalled();
  expect(
    await screen.findByText(
      "Reload the source message before sending its attachment.",
    ),
  ).toBeInTheDocument();
});

it("resends a reconciled thread reply when it is absent from the channel", async () => {
  const { session, send, dataTransfer } = setup();
  vi.mocked(session.channels.window).mockReturnValue({ rows: [] } as never);
  const dispose = vi.fn();
  const reply = { ...source, threadRootId: "root" };
  vi.mocked(session.thread).mockReturnValue({
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ targetStatus: "ready", target: reply }),
    dispose,
  } as never);
  fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  expect(
    await screen.findByText("Attachment sent to Design"),
  ).toBeInTheDocument();
  expect(session.thread).toHaveBeenCalledWith("origin", "source", {
    exact: true,
  });
  expect(send).toHaveBeenCalledWith("destination", reply, [attachment]);
  expect(dispose).toHaveBeenCalledOnce();
});

it("keeps feedback after the sidebar row unmounts", async () => {
  const send = vi.fn();
  const session = {
    channels: { window: () => ({ rows: [source] }) },
    messages: { resendAttachments: send },
  } as unknown as RelaySession;
  const { rerender } = render(
    <ToastProvider>
      <AttachmentForwardDropTarget channel={channel} session={session}>
        <button type="button">Design</button>
      </AttachmentForwardDropTarget>
    </ToastProvider>,
  );
  const dataTransfer = {
    types: [ATTACHMENT_FORWARD_MIME],
    getData: () => attachmentForwardPayload(source, [attachment]),
  };
  fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  rerender(
    <ToastProvider>
      <span>Collapsed</span>
    </ToastProvider>,
  );
  expect(
    await screen.findByText("Attachment sent to Design"),
  ).toBeInTheDocument();
});

it("matches normalized attachment URLs from rendered rows", async () => {
  const { session, send, dataTransfer } = setup();
  const raw = { ...attachment, url: "https://RELAY.test:443/media/photo.png" };
  const rawSource = { ...source, attachments: [raw] };
  vi.mocked(session.channels.window).mockReturnValue({
    rows: [rawSource],
  } as never);
  fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
    dataTransfer,
  });
  expect(send).toHaveBeenCalledWith("destination", rawSource, [attachment]);
});

it("forwards an edited thread reply through the real thread fold and message outbox", async () => {
  const { createThreadView } = await import("../relay/threads");
  const { createMessages } = await import("../relay/messages");
  const { createOutbox } = await import("../relay/outbox");
  const { keypair, message, signed } = await import("../relay/testing");
  const author = keypair();
  const root = message(author, "origin", "Thread", 1);
  const reply = message(author, "origin", "Reply", 2, [
    ["e", root.id, "", "reply"],
    ["imeta", "url https://example.com/old.png", "m image/png"],
  ]);
  const edit = signed(author, {
    kind: 40003,
    created_at: 3,
    content: "Edited",
    tags: [
      ["h", "origin"],
      ["e", reply.id],
      ["imeta", "url https://EXAMPLE.com:443/new.png", "m image/png"],
    ],
  });
  const view = createThreadView({
    channelId: "origin",
    messageId: reply.id,
    relayAuthor: author.pubkey,
    reader: {
      read: async (filters) => {
        const filter = filters[0];
        if (filter?.ids)
          return filter.ids.includes(reply.id) ? [reply] : [root];
        if (filter?.["#e"]?.includes(reply.id)) return [edit];
        if (filter?.["#e"]?.includes(edit.id)) return [];
        return [root, reply, edit];
      },
    },
    seed: undefined,
    local: undefined,
    canAccess: () => true,
    visible: (events) => events,
    notify: (listener) => listener(),
    exact: true,
  });
  const { outbox } = createOutbox(
    author.pubkey,
    {
      kinds: [9],
      sign: async (template) => signed(author, template),
      publish: async () => {},
    },
    { load: () => [], save: () => {} },
  );
  await outbox.ready();
  const messages = createMessages(
    outbox,
    author.pubkey,
    view.event,
    () => [],
    () => {},
    () => true,
  );
  const session = {
    channels: { window: () => ({ rows: [] }) },
    thread: () => view.view,
    messages,
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <AttachmentForwardDropTarget channel={channel} session={session}>
        <button type="button">Design</button>
      </AttachmentForwardDropTarget>
    </ToastProvider>,
  );
  const drag = { id: reply.id, channelId: "origin" };
  const dataTransfer = {
    types: [ATTACHMENT_FORWARD_MIME],
    getData: () =>
      attachmentForwardPayload(drag, [{ url: "https://example.com/new.png" }]),
  };
  try {
    fireEvent.drop(screen.getByRole("button", { name: "Design" }), {
      dataTransfer,
    });
    expect(
      await screen.findByText("Attachment sent to Design"),
    ).toBeInTheDocument();
    const sent = outbox.snapshot()[0]?.event;
    expect(sent?.tags).toContainEqual(edit.tags[2]);
    expect(sent?.tags.some(([name]) => name === "buzz:copy-of")).toBe(false);
    expect(sent?.content).toContain("https://example.com/new.png");
  } finally {
    view.view.dispose();
  }
});
