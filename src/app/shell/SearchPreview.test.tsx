// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { RelaySession } from "../../features/relay/session";
import { type PeekFollow, SearchPreview } from "./SearchPreview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const list = { channels: [] };
const noProfiles = new Map();

const event = (id: string, createdAt: number, content: string) => ({
  id,
  kind: 9,
  pubkey: "author",
  created_at: createdAt,
  content,
  tags: [["h", "channel"]],
});

it("holds room for a message's earlier neighbours, so the hit stays put as they load", async () => {
  vi.useFakeTimers();
  const pages: ((events: unknown[]) => void)[] = [];
  const profiles = new Map();
  const session = {
    readPage: vi.fn(
      () =>
        new Promise((resolve) => {
          pages.push((events) => resolve({ events }));
        }),
    ),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const lines = () => [...document.querySelectorAll(".search-peek-line")];
  const hitIndex = () =>
    lines().findIndex((line) => line.matches("[data-hit]"));
  render(
    <SearchPreview
      session={session}
      row={{
        key: "m:hit",
        label: "the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "the hit",
        },
      }}
      tone="message"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />,
  );
  // Two hidden slots hold the earlier lines' room before any read.
  expect(hitIndex()).toBe(2);
  expect(lines()[0]).toHaveAttribute("aria-hidden", "true");
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(pages).toHaveLength(2);
  expect(hitIndex()).toBe(2);
  await act(async () => {
    pages[0]?.([event("a", 900, "first"), event("b", 950, "second")]);
    pages[1]?.([event("c", 1010, "after")]);
  });
  // One message in the minute after: the next read looks an hour ahead.
  expect(session.readPage).toHaveBeenLastCalledWith(
    [expect.objectContaining({ since: 1000, until: 4600 })],
    expect.anything(),
  );
  await act(async () => {
    pages[2]?.([event("d", 2000, "later"), event("c", 1010, "after")]);
  });
  // The neighbours take the slots' place: the hit is still third.
  expect(document.querySelector("[data-slot]")).toBeNull();
  expect(hitIndex()).toBe(2);
  expect(lines().map((line) => line.textContent)).toEqual([
    expect.stringContaining("first"),
    expect.stringContaining("second"),
    expect.stringContaining("the hit"),
    expect.stringContaining("after"),
    expect.stringContaining("later"),
  ]);
});

function messagePreview(session: RelaySession) {
  return (
    <SearchPreview
      session={session}
      row={{
        key: "m:hit",
        label: "the hit",
        icon: ChatCircleIcon,
        run: () => {},
        peek: {
          kind: "message",
          channelId: "channel",
          messageId: "hit",
          createdAt: 1000,
          authorId: "author",
          text: "the hit",
        },
      }}
      tone="message"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#channel"}
    />
  );
}

it("shows no later neighbours from a window cut off at a full page", async () => {
  vi.useFakeTimers();
  const replies = Array.from({ length: 20 }, (_, index) =>
    event(`r${index}`, 2000 + index, `reply ${index}`),
  );
  const pages = [[], [event("c", 1010, "after")], replies];
  const session = {
    readPage: vi.fn(async () => ({ events: pages.shift() ?? [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => noProfiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(messagePreview(session));
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  // The hour's page is full, so its earliest replies may not be the next
  // ones: the preview keeps the minute's whole answer instead.
  expect(session.readPage).toHaveBeenCalledTimes(3);
  expect(
    [...document.querySelectorAll(".search-peek-line")].map(
      (line) => line.textContent,
    ),
  ).toEqual([
    expect.stringContaining("the hit"),
    expect.stringContaining("after"),
  ]);
});

it("drops a held preview once its channel can no longer be read", async () => {
  vi.useFakeTimers();
  let readable = true;
  let channels = { channels: [] };
  const listeners = new Set<() => void>();
  const readPage = vi.fn(async () => ({
    events: [event("a", 900, "private words")],
  }));
  const session = {
    readPage,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => noProfiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => (readable ? {} : undefined),
      list: () => channels,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const { unmount } = render(messagePreview(session));
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(document.body).toHaveTextContent("private words");
  act(() => {
    // As the session does: losing access publishes a new channel list.
    readable = false;
    channels = { channels: [] };
    for (const listener of listeners) listener();
  });
  expect(document.body).not.toHaveTextContent("private words");
  expect(document.body).not.toHaveTextContent("the hit");
  // Highlighting it again shows nothing from the cache, without a read.
  unmount();
  const reads = readPage.mock.calls.length;
  render(messagePreview(session));
  expect(document.body).not.toHaveTextContent("private words");
  expect(session.readPage).toHaveBeenCalledTimes(reads);
});

it("reads for a highlight nobody moved only once typing pauses and results settle", async () => {
  vi.useFakeTimers();
  const profiles = new Map();
  const session = {
    readPage: vi.fn(() => Promise.resolve({ events: [] })),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: () => Promise.resolve(),
    },
    channels: {
      get: () => ({}),
      list: () => list,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const preview = (follow: PeekFollow) => (
    <SearchPreview
      session={session}
      row={{
        key: "channel:design",
        label: "design",
        icon: ChatCircleIcon,
        run: () => {},
        peek: { kind: "channel", channelId: "design" },
      }}
      tone="channel"
      terms={[]}
      nameOf={() => "Author"}
      whereOf={() => "#design"}
      follow={follow}
    />
  );
  const wait = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  // Each key restarts the pause, so a row first while someone types is not
  // read even when typing is slower than the pause on a moved highlight.
  const { rerender } = render(preview({ text: "d", busy: false }));
  await wait(250);
  rerender(preview({ text: "de", busy: false }));
  await wait(250);
  expect(session.readPage).not.toHaveBeenCalled();
  // Results that may lead are still arriving.
  rerender(preview({ text: "des", busy: true }));
  await wait(1000);
  expect(session.readPage).not.toHaveBeenCalled();
  rerender(preview({ text: "des", busy: false }));
  await wait(299);
  expect(session.readPage).not.toHaveBeenCalled();
  await wait(1);
  expect(session.readPage).toHaveBeenCalledTimes(1);
});
