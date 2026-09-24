// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

const videoAttachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

function setupReview(initialTime = 7) {
  const viewer = keypair();
  const root = message(viewer, "one", "Video", 1, [
    ["imeta", `url ${videoAttachment.url}`, "m video/mp4"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => `media:${url}`,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  render(
    <MediaReviewViewer
      attachment={videoAttachment}
      session={owner.session}
      scope="video-review-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={initialTime}
      onOpenLink={() => false}
      close={() => {}}
    />,
  );
  return { root };
}

it("opens shared video review at the requested frame and tracks playback time", async () => {
  setupReview(7);
  const video = await waitFor(() => {
    const element = document.querySelector("video");
    if (!element) throw new Error("Missing video element");
    return element;
  });

  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(7);

  video.currentTime = 65;
  fireEvent.timeUpdate(video);

  expect(screen.getByText("1:05")).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Comment at current frame" }),
  ).toBeChecked();
});

it("shows unavailable treatment when shared video review playback errors", async () => {
  setupReview();
  const video = await waitFor(() => {
    const element = document.querySelector("video");
    if (!element) throw new Error("Missing video element");
    return element;
  });

  fireEvent.error(video);

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Media unavailable",
  );
  expect(document.querySelector("video")).toBeNull();
});
