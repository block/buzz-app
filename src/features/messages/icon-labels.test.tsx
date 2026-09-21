// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MediaAttachment } from "./MediaAttachment";
import { ImageReviewStage } from "./ImageReviewStage";
afterEach(cleanup);
it("keeps playback controls named for their actions, not icon components", () => {
  const { container } = render(
    <MediaAttachment
      attachment={{ url: "https://example.test/a.mp4", kind: "video" }}
      media={(url) => url}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing player");
  fireEvent.play(video);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
});
it("keeps the image download accessible name", () => {
  const url = "https://example.test/a.png";
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
    />,
  );
  expect(screen.getByRole("link", { name: "Download image" })).toHaveAttribute(
    "href",
    url,
  );
});
