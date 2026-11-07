// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, profile, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";
import type { MessageLinkOrigin } from "./MessageRow";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("keeps fullscreen comment avatar hints in sync without loading the agent library", async () => {
  const viewer = keypair(),
    marked = keypair(),
    libraryAgent = keypair(),
    envelope = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const tags = [["e", root.id, "", "reply"]];
  const replies = [
    message(viewer, "one", "Human comment", 2, tags),
    message(marked, "one", "Profile agent comment", 3, tags),
    message(libraryAgent, "one", "Library agent comment", 4, tags),
    signed(envelope, {
      kind: 40002,
      content: JSON.stringify({ content: "Envelope agent comment" }),
      created_at: 5,
      tags: [["h", "one"], ...tags],
    }),
  ];
  let identities = [{ pubkey: libraryAgent.pubkey, name: "Library agent" }];
  const readAgentLibrary = vi.fn(async () => ({ definitions: [], identities }));
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(marked, { name: "Profile agent", is_agent: true }),
    profile(libraryAgent, { name: "Library agent" }),
    profile(envelope, { name: "Envelope agent" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    readAgentLibrary,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, ...replies].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return replies.filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor,
          );
        return [];
      });
    },
  });
  owners.push(owner);
  render(
    <StrictMode>
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope="avatar-test"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        onOpenLink={() => false}
        close={() => {}}
      />
    </StrictMode>,
  );
  const avatar = (text: string) =>
    screen
      .getByText(text)
      .closest("[data-message-id]")
      ?.querySelector("[data-avatar-shape]");
  await screen.findByText("Profile agent comment");
  await waitFor(() => {
    expect(avatar("Human comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Profile agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    expect(avatar("Library agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Envelope agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
  });
  expect(readAgentLibrary).not.toHaveBeenCalled();
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  identities = [];
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(avatar("Profile agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(readAgentLibrary).toHaveBeenCalledTimes(2);
});

it("renders comment mentions as names when the host cannot open profiles", async () => {
  const viewer = keypair(),
    tyler = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const reply = message(viewer, "one", "I think @Tyler is looking at that", 2, [
    ["e", root.id, "", "reply"],
    ["p", tyler.pubkey],
  ]);
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(tyler, { name: "Tyler" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, reply].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return filter.thread_cursor === undefined ||
            reply.created_at > filter.thread_cursor
            ? [reply]
            : [];
        return [];
      });
    },
  });
  owners.push(owner);
  render(
    <MediaReviewViewer
      attachment={attachment}
      session={owner.session}
      scope="mention-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={() => false}
      close={() => {}}
    />,
  );
  const mention = await screen.findByText("Tyler", {
    selector: "[data-mention-kind]",
  });
  expect(mention).toHaveAttribute("data-mention-kind", "person");
  expect(mention.tagName).toBe("SPAN");
});

/** Sam's comment mentions Tyler and links another message. */
function linkedComment() {
  const viewer = keypair(),
    sam = keypair(),
    tyler = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const link = `buzz://message?channel=one&id=${"a".repeat(64)}`;
  const reply = message(sam, "one", `I think @Tyler wrote <${link}>`, 2, [
    ["e", root.id, "", "reply"],
    ["p", tyler.pubkey],
  ]);
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(sam, { name: "Sam" }),
    profile(tyler, { name: "Tyler" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, reply].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return filter.thread_cursor === undefined ||
            reply.created_at > filter.thread_cursor
            ? [reply]
            : [];
        return [];
      });
    },
  });
  owners.push(owner);
  return {
    link,
    rootId: root.id,
    sam: `nostr:${npubEncode(sam.pubkey)}`,
    tyler: `nostr:${npubEncode(tyler.pubkey)}`,
    props: {
      attachment,
      session: owner.session,
      scope: "comment-links",
      channelId: "one",
      channelName: "One",
      messageId: root.id,
      initialTime: 0,
      canOpenLink: (target: string) => target.startsWith("nostr:"),
    },
  };
}

it("opens comment mentions, avatars and links through its host, then closes", async () => {
  const { link, rootId, sam, tyler, props } = linkedComment();
  const opener = document.body.appendChild(document.createElement("button"));
  // The comment leaves with the review; its opener is the return target.
  const origin = { rootId, returnFocus: opener };
  const calls: unknown[][] = [];
  let accept = true;
  render(
    <MediaReviewViewer
      {...props}
      restoreFocus={{ current: opener }}
      onOpenLink={(url: string, origin?: MessageLinkOrigin) => {
        calls.push(["open", url, origin]);
        return accept;
      }}
      close={() => calls.push(["close"])}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "View Tyler profile" }),
  );
  expect(calls.splice(0)).toEqual([["open", tyler, origin], ["close"]]);
  fireEvent.click(screen.getByRole("button", { name: "View Sam profile" }));
  expect(calls.splice(0)).toEqual([["open", sam, origin], ["close"]]);
  // A refused link keeps the review and says so; an accepted one leaves it.
  accept = false;
  const anchor = within(
    screen.getByRole("region", { name: "Media comments" }),
  ).getByRole("link");
  expect(anchor).toHaveAttribute("href", link);
  fireEvent.click(anchor);
  expect(calls.splice(0)).toEqual([["open", link, origin]]);
  expect(
    screen.getByText("This Buzz link couldn’t be opened here."),
  ).toBeInTheDocument();
  accept = true;
  fireEvent.click(anchor);
  expect(calls.splice(0)).toEqual([["open", link, origin], ["close"]]);
  opener.remove();
});

it("leaves focus with a followed comment link's destination until it closes", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const { props } = linkedComment();
  // Like a profile tab, the destination takes focus when it mounts and
  // returns it to its trigger when it closes.
  function Destination({ close }: { close(): void }) {
    const button = useRef<HTMLButtonElement>(null);
    useEffect(() => {
      button.current?.focus();
    }, []);
    return (
      <button ref={button} type="button" onClick={close}>
        Close Tyler profile
      </button>
    );
  }
  function Host() {
    const opener = useRef<HTMLButtonElement>(null);
    // As Channels does: the link's named target, else what had focus.
    const trigger = useRef<HTMLElement | null>(null);
    const [reviewing, setReviewing] = useState(false);
    const [destination, setDestination] = useState(false);
    return (
      <>
        <button ref={opener} type="button" onClick={() => setReviewing(true)}>
          View image
        </button>
        {destination && (
          <Destination
            close={() => {
              setDestination(false);
              if (trigger.current?.isConnected) trigger.current.focus();
            }}
          />
        )}
        {reviewing && (
          <MediaReviewViewer
            {...props}
            restoreFocus={opener}
            onOpenLink={(_url, origin) => {
              trigger.current =
                origin?.returnFocus ??
                (document.activeElement as HTMLElement | null);
              setDestination(true);
              return true;
            }}
            close={() => setReviewing(false)}
          />
        )}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole("button", { name: "View image" });
  opener.focus();
  fireEvent.click(opener);
  const mention = await screen.findByRole("button", {
    name: "View Tyler profile",
  });
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
  mention.focus();
  fireEvent.click(mention);
  // The close's focus handoff is recorded in a microtask before its frame.
  await act(async () => {});
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const close = screen.getByRole("button", { name: "Close Tyler profile" });
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(opener).toHaveFocus();
});

it("wires image review links to the viewer host opener", async () => {
  const viewer = keypair();
  const image = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${image.url}`, "m image/png"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  const open = vi.fn(() => true);
  render(
    <MediaReviewViewer
      attachment={image}
      session={owner.session}
      scope="image-open-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={open}
      close={() => {}}
    />,
  );
  const link = await screen.findByRole("link", {
    name: "Open image in browser",
  });
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(image.url);
});

it("excludes generic files from the image review grid", async () => {
  const viewer = keypair();
  const image = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const file = {
    url: "https://fixture.test/report.pdf",
    kind: "file" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${image.url}`, "m image/png"],
    ["imeta", `url ${file.url}`, "m application/pdf"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  render(
    <MediaReviewViewer
      attachment={image}
      session={owner.session}
      scope="file-grid-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={() => false}
      close={() => {}}
    />,
  );
  const imageAttachment = await screen.findByAltText("Attachment preview");
  expect(imageAttachment).toHaveAttribute("src", image.url);
  expect(
    screen.queryByRole("button", { name: "Next image" }),
  ).not.toBeInTheDocument();
});

it("Escape closes media opened from a tab without closing the tab", async () => {
  const user = userEvent.setup();
  const viewer = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.some((filter) => filter.ids?.includes(root.id))
        ? [root]
        : [];
    },
  });
  owners.push(owner);
  const closeTab = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <PanelWorkspace
        value="one"
        select={() => {}}
        items={[
          {
            id: "one",
            label: "One",
            close: closeTab,
            content: (
              <>
                <button type="button" onClick={() => setOpen(true)}>
                  View image
                </button>
                {open && (
                  <MediaReviewViewer
                    attachment={attachment}
                    session={owner.session}
                    scope="tab-media"
                    channelId="one"
                    channelName="One"
                    messageId={root.id}
                    initialTime={0}
                    onOpenLink={() => false}
                    close={() => setOpen(false)}
                  />
                )}
              </>
            ),
          },
        ]}
      />
    );
  }
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "View image" }));
  expect(
    await screen.findByRole("link", { name: "Open image in browser" }),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(closeTab).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("link", { name: "Open image in browser" }),
  ).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "View image" })).toHaveFocus(),
  );
  expect(screen.getByRole("tab", { name: "One" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(closeTab).toHaveBeenCalledTimes(1);
});
