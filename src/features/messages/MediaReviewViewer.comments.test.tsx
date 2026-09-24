// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventTemplate } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];

afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

type MediaKind = "image" | "video";
type ReviewFixtureOptions = {
  kind: MediaKind;
  replies?: (
    viewer: ReturnType<typeof keypair>,
    root: RelayEvent,
  ) => readonly RelayEvent[];
  extraRootTags?: readonly string[][];
};

function mime(kind: MediaKind) {
  return kind === "video" ? "video/mp4" : "image/png";
}

async function setupReview({
  kind,
  replies: buildReplies = () => [],
  extraRootTags = [],
}: ReviewFixtureOptions) {
  const viewer = keypair();
  const relay = keypair();
  const attachment = {
    url: `https://fixture.test/${kind}.${kind === "video" ? "mp4" : "png"}`,
    kind,
  };
  const root = message(viewer, "one", `${kind} root`, 1, [
    ["imeta", `url ${attachment.url}`, `m ${mime(kind)}`],
    ...extraRootTags,
  ]);
  const replies = buildReplies(viewer, root);
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => {});
  const events = [root, ...replies];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      async query(filters) {
        return filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
            return [
              roster(relay, "one", [viewer.pubkey]),
              metadata(relay, "one", "One"),
            ];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.depth_limit)
            return replies.filter(
              (event) =>
                filter.thread_cursor === undefined ||
                event.created_at > filter.thread_cursor,
            );
          return [];
        });
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  await owner.session.read([
    { kinds: [39002, 39000], "#d": ["one"], limit: 10 },
  ]);
  const user = userEvent.setup();
  render(
    <MediaReviewViewer
      onOpenLink={() => false}
      attachment={attachment}
      session={owner.session}
      scope={`review-${kind}`}
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={72}
      close={() => {}}
      onOpenLink={() => false}
    />,
  );
  return { owner, root, sign, user };
}

async function signedTemplate(sign: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(sign).toHaveBeenCalled());
  return sign.mock.calls.at(-1)?.[0] as EventTemplate;
}

async function typeAndSend(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
    text,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
}

it("publishes checked video review comments as time-prefixed kind 9 replies to the root", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await screen.findByRole("dialog", { name: "Video review" });
  expect(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  ).toBeChecked();

  await typeAndSend(user, "adjust the cut");

  const event = await signedTemplate(sign);
  expect(event.kind).toBe(9);
  expect(event.content).toBe("⏱ 1:12 — adjust the cut");
  expect(event.tags).toEqual(
    expect.arrayContaining([
      ["h", "one"],
      ["e", root.id, "", "reply"],
    ]),
  );
});

it("publishes unchecked video review comments without a time prefix", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await user.click(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  );

  await typeAndSend(user, "plain comment");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("plain comment");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it("publishes image review comments as plain replies without a frame checkbox", async () => {
  const { root, sign, user } = await setupReview({ kind: "image" });
  await screen.findByRole("dialog", { name: "Image viewer" });
  expect(
    screen.queryByLabelText("Comment at current frame"),
  ).not.toBeInTheDocument();

  await typeAndSend(user, "image note");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("image note");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it("seeks the review video from a timecode reply when the thread has one video", async () => {
  const { user } = await setupReview({
    kind: "video",
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:42 — jump here", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  await screen.findByText("jump here");
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const video = dialog.querySelector("video");
  assert.exists(video);
  const play = vi.fn(async () => {});
  // jsdom does not implement media playback, so play() needs a test stub.
  Object.defineProperty(video, "play", { configurable: true, value: play });

  await user.click(screen.getByRole("button", { name: "0:42" }));

  // jsdom media time remains at initialTime until the seek handler sets it.
  expect(video.currentTime).toBe(42);
  expect(play).toHaveBeenCalledOnce();
});

it("preserves timecode reply text without a seek chip when the thread has multiple videos", async () => {
  await setupReview({
    kind: "video",
    extraRootTags: [
      ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
    ],
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:42 — keep text", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });

  expect(await screen.findByText("⏱ 0:42 — keep text")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "0:42" }),
  ).not.toBeInTheDocument();
});
