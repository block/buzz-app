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
import { MessageRow } from "./MessageRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows a details message's video in the dialog that opens it whole", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  render(
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
        attachments: [
          {
            kind: "video",
            url: "https://files.test/demo.mp4",
            name: "demo.mp4",
          },
        ],
        reactions: [],
        replyCount: 0,
      }}
      profile={{ name: "author" }}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
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
