// @vitest-environment jsdom
import {
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
  return { owner, scope, room };
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
