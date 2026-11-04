// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { AttachmentForwardDropTarget } from "./AttachmentForwardDropTarget";
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
