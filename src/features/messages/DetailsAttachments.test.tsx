// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { MediaAttachment } from "./MediaAttachment";
import { MessageRow } from "./MessageRow";

const setPaused = (video: HTMLMediaElement, paused: boolean) =>
  Object.defineProperty(video, "paused", { configurable: true, value: paused });

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    setPaused(this, false);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this.paused) return;
    setPaused(this, true);
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const video = {
  kind: "video" as const,
  url: "https://files.test/demo.mp4",
  name: "demo.mp4",
};
const image = (name: string) => ({
  kind: "image" as const,
  url: `https://files.test/${name}.png`,
  name: `${name}.png`,
});
const file = {
  kind: "file" as const,
  url: "https://files.test/report.pdf",
  name: "report.pdf",
};
const audio = {
  kind: "audio" as const,
  url: "https://files.test/voice.mp3",
  name: "voice.mp3",
};
const media = (url: string) =>
  `/api/relay/media?url=${encodeURIComponent(url)}`;

function row(
  attachments: ChannelMessage["attachments"],
  props: Partial<Parameters<typeof MessageRow>[0]> = {},
) {
  return (
    <MessageRow
      row={{
        id: "root",
        channelId: "channel",
        authorId: "author",
        audience: "details",
        content: "Findings brief\n\nMore of the findings follow.",
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments,
        reactions: [],
        replyCount: 0,
      }}
      profile={{ name: "author" }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      {...props}
    />
  );
}

it("shows a details message's video in the dialog that opens it whole", () => {
  render(row([video]));
  // The brief's player sits under its card.
  expect(screen.getAllByRole("button", { name: "Play video" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("More of the findings follow.")).toBeInTheDocument();
  expect(
    dialog.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("button", { name: "Open video fullscreen" }),
  ).toBeInTheDocument();
});

it("lists a details message's attachments in the dialog that opens it whole, as its row lists them", () => {
  // A plugin draws one image itself, as a card.
  const card = {
    id: "card",
    title: "Card",
    key: "test.plugin/card",
    pluginId: "test.plugin",
    revision: "one",
    matches: (attachment: { name?: string }) =>
      attachment.name === "Ada.agent.png",
    component: () => <span>Ada's card</span>,
  };
  const cards = [card];
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  render(
    row(
      [
        image("solo"),
        file,
        image("one"),
        image("two"),
        image("three"),
        image("four"),
        audio,
        { ...image("ada"), name: "Ada.agent.png" },
      ],
      {
        extensions: {
          tools: empty,
          inline: empty,
          attachments: { snapshot: () => cards, subscribe: () => () => {} },
        },
      },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(
    dialog.getByRole("link", { name: "Open image attachment" }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("link", { name: "Download report.pdf" }),
  ).toBeInTheDocument();
  // Four or more are the row's grid of tiles.
  expect(
    within(dialog.getByRole("group", { name: "4 images" })).getByRole("link", {
      name: "Open image 4 of 4",
    }),
  ).toBeInTheDocument();
  expect(
    dialog.getByRole("button", { name: "Play voice.mp3" }),
  ).toBeInTheDocument();
  expect(dialog.getByText("Ada's card")).toBeInTheDocument();
});

it("closes media opened from the reader's dialog on Escape, and leaves the dialog open", async () => {
  render(row([image("solo")]));
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("link", {
      name: "Open image attachment",
    }),
  );
  const close = screen.getByRole("button", { name: "Close fullscreen viewer" });
  fireEvent.keyDown(close, { key: "Escape" });
  await waitFor(() => expect(close).not.toBeInTheDocument());
  expect(
    within(screen.getByRole("dialog")).getByText(
      "More of the findings follow.",
    ),
  ).toBeInTheDocument();
});

it("leaves Escape to media open over the reader's dialog", async () => {
  render(row([video]));
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  // A page's media review opens over the dialog, outside it.
  const review = document.createElement("div");
  review.setAttribute("role", "dialog");
  review.setAttribute("aria-modal", "true");
  document.body.append(review);
  fireEvent.keyDown(review, { key: "Escape" });
  review.remove();
  expect(screen.getByRole("dialog", { name: "author" })).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "author" })).toBeNull(),
  );
});

it("draws no player in the reader for a video the row shows as a gallery tile", () => {
  render(
    row([image("one"), image("two"), image("three"), video], {
      onOpenMediaReview: () => {},
    }),
  );
  expect(screen.queryByRole("button", { name: "Play video" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("More of the findings follow.")).toBeInTheDocument();
  expect(dialog.queryByRole("button", { name: "Play video" })).toBeNull();
});

it("keeps a row mounted while a reader plays its video, to take it back", async () => {
  const release = vi.fn();
  const keepMounted = vi.fn(() => release);
  render(row([video], { keepMounted }));
  const brief = document.querySelector("video");
  if (!brief) throw new Error("Missing brief video");
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(keepMounted).toHaveBeenCalledExactlyOnceWith("root");
  // A pin is released a task after it is dropped.
  const later = () => act(() => new Promise((resolve) => setTimeout(resolve)));

  // The sheet over the composer draws the reader outside the row.
  const reader = render(
    <MediaAttachment
      attachment={video}
      media={media}
      handoff={{ messageId: "root", reader: true }}
    />,
  );
  expect(brief.paused).toBe(true);
  await later();
  expect(release).not.toHaveBeenCalled();
  reader.unmount();
  expect(brief.paused).toBe(false);
  await later();
  expect(release).not.toHaveBeenCalled();
  expect(keepMounted).toHaveBeenCalledOnce();
});
