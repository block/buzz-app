// @vitest-environment jsdom
import {
  act,
  cleanup as cleanupReact,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHuddleComposerClient } from "../../features/huddle/composer-client";
import { createHuddleComposerOwner } from "../../features/huddle/composer-owner";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import type { PopoutView } from "../../features/popout/window";
import { createRelaySession } from "../../features/relay/session";
import { useHuddleComposer } from "../huddles/HuddleComposer";
import { linkRenderer } from "../links";
import { PopoutWindowView } from "./PopoutWindowView";

// The pop-out editor through the real owner/client bridge: what main
// projects (tools, uploads) is what the pop-out's composer offers.
composerDOMFixture();
const cleanup: (() => void)[] = [];
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Node's BroadcastChannel loses File identity; deliver in order instead.
  const peers = new Set<{
    name: string;
    onmessage?: (event: { data: unknown }) => void;
  }>();
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      constructor(readonly name: string) {
        peers.add(this);
      }
      postMessage(data: unknown) {
        for (const peer of peers)
          if (peer !== this && peer.name === this.name)
            queueMicrotask(() => {
              if (peers.has(peer)) peer.onmessage?.({ data });
            });
      }
      close() {
        peers.delete(this);
      }
    },
  );
});
afterEach(() => {
  cleanupReact();
  for (const fn of cleanup.splice(0).reverse()) fn();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function harness() {
  const store = createRelaySession(null);
  const viewer = "ab".repeat(32);
  const room = "room";
  const scope = `https://example.test:${viewer}`;
  const metadata = {
    id: room,
    name: "Design",
    huddle: true as const,
    parentChannelId: "parent",
    members: [viewer],
  };
  const session = {
    ...store.session,
    viewer,
    scope,
    channels: { ...store.session.channels, get: () => metadata },
    attachments: {
      upload: vi.fn(async (file: File) => ({
        name: file.name,
        url: `https://example.test/media/${file.name}`,
        type: file.type,
        size: file.size,
        sha256: "ab".repeat(32),
      })),
    },
    messages: { ...store.session.messages, send: vi.fn(() => "id") },
  };
  const owner = createHuddleComposerOwner(
    session,
    room,
    "parent",
    {
      tools: {
        snapshot: () => [
          {
            key: "buzz.voice-notes/recorder",
            id: "recorder",
            title: "Voice Notes",
            pluginId: "buzz.voice-notes",
            revision: "bundled",
            component: () => null,
          },
        ],
        subscribe: () => () => {},
      },
    },
    () => true,
  );
  cleanup.push(
    () => store.dispose(),
    () => owner.dispose(),
  );
  return { owner, scope, room, session };
}
const view = (h: ReturnType<typeof harness>): PopoutView => ({
  title: "Design",
  scope: h.scope,
  dark: false,
  status: "ready",
  writable: true,
  canLoadMore: false,
  limited: false,
  loadingOlder: false,
  reading: undefined,
  readingRevision: 0,
  operations: [],
  following: false,
  isDm: false,
  kind: "channel",
  thread: true,
  version: 1,
  root: {
    id: "1".repeat(64),
    author: "Ada",
    authorId: "a".repeat(64),
    channelId: h.room,
    attachments: [],
    picture: null,
    text: "Root",
    time: 1_700_000_000,
    delivery: "seen",
  },
  replies: [],
  composer: h.owner.token,
});

it("offers the recorder main enabled in the pop-out's editor, and guards a file it keeps", async () => {
  const h = harness();
  const client = createHuddleComposerClient(h.owner.token);
  cleanup.push(() => client.dispose());
  await vi.waitFor(() =>
    expect(client.snapshot().data?.tools).toContain(
      "buzz.voice-notes/recorder",
    ),
  );
  expect(client.snapshot().data?.uploads).toBe(true);
  const act = vi.fn();
  const mounted = render(<PopoutWindowView view={view(h)} act={act} />);
  await screen.findByRole("textbox", { name: "Reply to thread" });
  expect(
    screen.getByRole("button", { name: "Record voice note" }),
  ).toBeTruthy();
  const input = mounted.container.querySelector('input[type="file"]');
  if (!input) throw new Error("Missing file picker");
  fireEvent.change(input, {
    target: { files: [new File(["note"], "note.txt", { type: "text/plain" })] },
  });
  await screen.findByRole("button", { name: "Remove note.txt" });
  // The retained file is unsent work of this window: native asks before close.
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
});

it("never offers the recorder to the Huddle companion", async () => {
  const h = harness();
  function Companion() {
    return useHuddleComposer(h.owner.token);
  }
  render(<Companion />);
  await screen.findByRole("textbox", { name: "Message this Huddle" });
  expect(
    screen.queryByRole("button", { name: "Record voice note" }),
  ).toBeNull();
});

it("keeps a conversation's files and close protection while drilled into a thread, and restores them on back", async () => {
  const h = harness();
  // The same main session owns the thread frame's composer.
  const threadOwner = createHuddleComposerOwner(
    h.session,
    h.room,
    h.room,
    undefined,
    () => true,
    () => true,
    undefined,
    "1".repeat(64),
  );
  cleanup.push(() => threadOwner.dispose());
  const act = vi.fn();
  const conversation = { ...view(h), thread: false, root: undefined };
  const thread = {
    ...view(h),
    thread: true,
    canGoBack: true,
    composer: threadOwner.token,
  };
  const mounted = render(<PopoutWindowView view={conversation} act={act} />);
  await screen.findByRole("textbox", { name: "Message #Design" });
  const input = mounted.container.querySelector('input[type="file"]');
  if (!input) throw new Error("Missing file picker");
  fireEvent.change(input, {
    target: {
      files: [new File(["unsent"], "kept.txt", { type: "text/plain" })],
    },
  });
  await screen.findByRole("button", { name: "Remove kept.txt" });
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
  // Drill into a thread: the conversation's file is still this window's
  // unsent work, so the close guard stays up.
  mounted.rerender(<PopoutWindowView view={thread} act={act} />);
  await screen.findByRole("textbox", { name: "Reply to thread" });
  expect(screen.queryByRole("button", { name: "Remove kept.txt" })).toBeNull();
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
  // Back: the file is where it was left.
  mounted.rerender(<PopoutWindowView view={conversation} act={act} />);
  await screen.findByRole("textbox", { name: "Message #Design" });
  expect(
    await screen.findByRole("button", { name: "Remove kept.txt" }),
  ).toBeTruthy();
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
});

it("keeps every retained draft: the first of nine threads' files is still there when it is reopened", async () => {
  const h = harness();
  const threadOwners = Array.from({ length: 9 }, (_, i) => {
    const owner = createHuddleComposerOwner(
      h.session,
      h.room,
      h.room,
      undefined,
      () => true,
      () => true,
      undefined,
      String(i + 1).padStart(64, "0"),
    );
    cleanup.push(() => owner.dispose());
    return owner;
  });
  const act = vi.fn();
  const conversation = { ...view(h), thread: false, root: undefined };
  const threadView = (i: number) => ({
    ...view(h),
    thread: true,
    canGoBack: true,
    composer: threadOwners[i]?.token,
  });
  const mounted = render(<PopoutWindowView view={conversation} act={act} />);
  await screen.findByRole("textbox", { name: "Message #Design" });
  for (let i = 0; i < 9; i++) {
    mounted.rerender(<PopoutWindowView view={threadView(i)} act={act} />);
    await screen.findByRole("textbox", { name: "Reply to thread" });
    const input = mounted.container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing file picker");
    fireEvent.change(input, {
      target: {
        files: [new File(["t"], `thread-${i + 1}.txt`, { type: "text/plain" })],
      },
    });
    await screen.findByRole("button", { name: `Remove thread-${i + 1}.txt` });
    mounted.rerender(<PopoutWindowView view={conversation} act={act} />);
    await screen.findByRole("textbox", { name: "Message #Design" });
  }
  mounted.rerender(<PopoutWindowView view={threadView(0)} act={act} />);
  expect(
    await screen.findByRole("button", { name: "Remove thread-1.txt" }),
  ).toBeTruthy();
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
});

it("asks before leaving a view while a voice note is being recorded", async () => {
  const track = { stop: vi.fn(), kind: "audio" };
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
  });
  class Recorder extends EventTarget {
    state = "inactive";
    static isTypeSupported = () => true;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser = () => ({ fftSize: 0, smoothingTimeConstant: 0 });
      createMediaStreamSource = () => ({ connect: () => {} });
      close = async () => {};
    },
  );
  const h = harness();
  const act = vi.fn();
  const root = view(h).root as NonNullable<PopoutView["root"]>;
  const conversation: PopoutView = {
    ...view(h),
    thread: false,
    root: undefined,
    replies: [{ ...root, replyCount: 2 }],
  };
  render(<PopoutWindowView view={conversation} act={act} />);
  await screen.findByRole("textbox", { name: "Message #Design" });
  fireEvent.click(
    await screen.findByRole("button", { name: "Record voice note" }),
  );
  await waitFor(() => expect(act).toHaveBeenLastCalledWith("guard", "1"));
  fireEvent.click(
    screen.getByRole("button", { name: /View thread: 2 replies/ }),
  );
  expect(act).not.toHaveBeenCalledWith("openThread", expect.anything());
  expect(screen.getByText("Discard your recording?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
  expect(act).not.toHaveBeenCalledWith("openThread", expect.anything());
  expect(track.stop).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: /View thread: 2 replies/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard and continue" }));
  expect(act).toHaveBeenCalledWith("openThread", root.id);
});

it("labels links as main does: its enabled link renderer, channel names from its list and its byline for message links, in rows and the editor", async () => {
  const h = harness();
  const design = {
    id: "design",
    name: "design",
    channelType: "stream" as const,
    members: [h.session.viewer],
  };
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      list: () => ({ ...h.session.channels.list(), channels: [design] }),
    },
  };
  const owner = createHuddleComposerOwner(
    session,
    h.room,
    "parent",
    {
      tools: { snapshot: () => [], subscribe: () => () => {} },
      links: {
        snapshot: () => [
          {
            ...linkRenderer,
            key: "buzz.links/links",
            pluginId: "buzz.links",
            revision: "bundled",
          },
        ],
        subscribe: () => () => {},
      },
    },
    () => true,
  );
  cleanup.push(() => owner.dispose());
  const client = createHuddleComposerClient(owner.token);
  cleanup.push(() => client.dispose());
  await vi.waitFor(() =>
    expect(client.snapshot().data?.links).toEqual(["buzz.links/links"]),
  );
  const message = `buzz://message?channel=design&id=${"9".repeat(64)}`;
  const unknown = `buzz://message?channel=design&id=${"8".repeat(64)}`;
  const mounted = render(
    <PopoutWindowView
      view={{
        ...view(h),
        composer: owner.token,
        root: {
          ...(view(h).root as NonNullable<PopoutView["root"]>),
          text: `See ${message}, ${unknown} and buzz://channel/design`,
          linkLabels: { [message]: "Bea in #design" },
        },
      }}
      act={vi.fn()}
    />,
  );
  // Main's byline for the link it has read; the channel's name for one it
  // hasn't, and for a channel link; each with the renderer's icon.
  // The renderer arrives with the bridge's first snapshot.
  await waitFor(() =>
    expect(
      screen
        .getByRole("link", { name: "Bea in #design" })
        .querySelector('[data-link-kind="message"]'),
    ).toBeTruthy(),
  );
  const pending = screen.getByRole("link", { name: "design" });
  expect(pending.getAttribute("href")).toBe(unknown);
  expect(pending.querySelector('[data-link-kind="message"]')).toBeTruthy();
  const channel = screen.getByRole("link", { name: "#design" });
  expect(channel.querySelector('[data-link-kind="channel"]')).toBeTruthy();
  // The editor decorates a pasted message link with the same renderer.
  const input = await screen.findByRole("textbox", { name: "Reply to thread" });
  act(() => {
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? `${message} ` : ""),
      },
    });
  });
  await waitFor(() =>
    expect(
      mounted.container.querySelector('form [data-link-kind="message"]')
        ?.textContent,
    ).toBe("design"),
  );
});

it("focuses the thread's editor once it connects after Reply from a conversation window", async () => {
  const h = harness();
  // The thread frame's own composer owner, as the window owner creates it.
  const threadOwner = createHuddleComposerOwner(
    h.session,
    h.room,
    h.room,
    undefined,
    () => true,
    () => true,
    undefined,
    "1".repeat(64),
  );
  cleanup.push(() => threadOwner.dispose());
  const act = vi.fn();
  const conversation = {
    ...view(h),
    thread: false,
    root: undefined,
    composer: undefined,
    replies: [{ ...(view(h).root as NonNullable<PopoutView["root"]>) }],
  };
  const mounted = render(<PopoutWindowView view={conversation} act={act} />);
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Reply" }))[0] as HTMLElement,
  );
  expect(act).toHaveBeenCalledWith("openThread", "1".repeat(64));
  // Main re-points the window at the thread; its editor connects later.
  mounted.rerender(
    <PopoutWindowView
      view={{
        ...view(h),
        thread: true,
        canGoBack: true,
        composer: threadOwner.token,
      }}
      act={act}
    />,
  );
  const editor = await screen.findByRole("textbox", {
    name: "Reply to thread",
  });
  await waitFor(() => expect(document.activeElement).toBe(editor));
});
