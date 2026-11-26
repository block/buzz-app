// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationChannel } from "../conversation/Conversation";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { LayerReader } from "./LayerReader";
import { LayerAddressContext } from "./view-layer";

// No media listener: `media_stream_base` reports none.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

afterEach(cleanup);

const video = (name: string) => ({
  kind: "video" as const,
  url: `https://files.test/${name}.mp4`,
  name: `${name}.mp4`,
});

const image = (name: string) => ({
  kind: "image" as const,
  url: `https://files.test/${name}.png`,
  name: `${name}.png`,
});

it("reads a details message with the attachments its row lists, in a dialog where the view has no composer", () => {
  const viewer = "a".repeat(64);
  const message: ChannelMessage = {
    id: "d".repeat(64),
    channelId: "c",
    authorId: "b".repeat(64),
    audience: "details",
    content: "Findings brief\n\nMore of the findings follow.",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [
      video("card"),
      video("demo"),
      {
        kind: "file",
        url: "https://files.test/report.pdf",
        name: "report.pdf",
      },
      image("solo"),
      { kind: "audio", url: "https://files.test/voice.mp3", name: "voice.mp3" },
      image("one"),
      image("two"),
      image("three"),
      image("four"),
    ],
    reactions: [],
    replyCount: 0,
  };
  const none = () => () => {};
  const profiles = new Map();
  const nothing: never[] = [];
  const list = {
    channels: [{ id: "c", name: "Channel", members: [viewer] }],
  };
  const window = { rows: [message] };
  const session = {
    viewer,
    channels: {
      ensure: none,
      subscribeList: none,
      list: () => list,
      subscribeWindow: none,
      window: () => window,
    },
    profiles: {
      ensure: async () => {},
      snapshot: () => profiles,
      subscribe: none,
    },
    media: (url: string) => `/api/relay/media?url=${encodeURIComponent(url)}`,
    unread: {
      revision: () => 0,
      sync: () => ({ capability: "unsupported" }),
      snapshot: () => undefined,
      subscribe: none,
      attention: () => ({ unread: false }),
      enterChannel: async () => {},
      leaveChannel() {},
      setChannelActive() {},
    },
    outbox: {
      subscribe: none,
      observeSend: none,
      snapshot: () => nothing,
      supports: () => true,
    },
  } as unknown as RelaySession;
  // A message renderer draws the first video in its own card, so the row
  // leaves it out.
  const card = {
    key: "fixture/card",
    id: "card",
    pluginId: "fixture",
    revision: "1",
    title: "Card",
    matches: () => true,
    ownsAttachment: (_: ChannelMessage, attachment: { url: string }) =>
      attachment.url.endsWith("card.mp4"),
    component: () => null,
  };
  const cards = [card];
  const empty = { subscribe: none, snapshot: () => nothing };
  const extensions = {
    messages: { subscribe: none, snapshot: () => cards },
    tools: empty,
    inline: empty,
  } as unknown as ConversationExtensions;
  const dismiss = vi.fn();
  render(
    <LayerAddressContext
      value={{
        open: { channelId: "c", messageId: message.id },
        show() {},
        dismiss,
        renderPanel: () => undefined,
      }}
    >
      <ConversationChannel
        session={session}
        scope={`https://fixture.test:${viewer}`}
        extensions={extensions}
        channel={{ id: "c", name: "Channel" }}
        interactions={{
          onOpenLink: () => false,
          canOpenLink: () => false,
          onOpenMediaReview() {},
        }}
      >
        <LayerReader channelId="c" />
      </ConversationChannel>
    </LayerAddressContext>,
  );
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("More of the findings follow.")).toBeInTheDocument();
  expect(dialog.getAllByRole("button", { name: "Play video" })).toHaveLength(1);
  expect(
    dialog.getByRole("button", { name: "Open video fullscreen" }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("link", { name: "Download report.pdf" }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("link", { name: "Open image attachment" }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("button", { name: "Play voice.mp3" }),
  ).toBeInTheDocument();
  // Four or more are the row's grid of tiles.
  expect(
    within(dialog.getByRole("group", { name: "4 images" })).getByRole("link", {
      name: "Open image 4 of 4",
    }),
  ).toBeInTheDocument();

  // Media open over the dialog, outside it, takes Escape.
  const review = document.createElement("div");
  review.setAttribute("role", "dialog");
  review.setAttribute("aria-modal", "true");
  document.body.append(review);
  fireEvent.keyDown(review, { key: "Escape" });
  review.remove();
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(dismiss).toHaveBeenCalledOnce();
});
