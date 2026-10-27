// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { ReferenceText, useReferenceDirectory } from "./ReferenceText";

afterEach(cleanup);

/** A ready session whose joined list and warm public directory the test controls. */
function session(joined: readonly ChannelSummary[]) {
  const listeners = new Set<() => void>();
  let list: ChannelList = { status: "ready", channels: joined };
  let open: readonly ChannelSummary[] = [];
  const channels = {
    list: () => list,
    subscribeList: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDirectory: () => open,
  };
  return {
    session: { viewer: "v".repeat(64), channels } as unknown as RelaySession,
    directoryRead(channels: readonly ChannelSummary[]) {
      open = channels;
      for (const listener of listeners) listener();
    },
    rename(next: readonly ChannelSummary[]) {
      list = { ...list, channels: next };
      for (const listener of listeners) listener();
    },
  };
}

function Body({ text, session }: { text: string; session: RelaySession }) {
  const directory = useReferenceDirectory(session);
  return (
    <ReferenceText
      text={text}
      mentions={[]}
      directory={directory}
      renderText={(part) => part}
      onOpenLink={() => true}
      session={session}
    />
  );
}

it("links #name prose to an unjoined open channel once the public directory has been read", () => {
  const h = session([{ id: "joined", name: "design" }]);
  render(<Body text="See #design and #release-notes." session={h.session} />);
  expect(screen.getByRole("link", { name: "#design" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
  // Cold directory: the name is prose until the directory names the channel.
  expect(screen.queryByRole("link", { name: "#release-notes" })).toBeNull();
  act(() =>
    h.directoryRead([
      { id: "open-1", name: "release-notes", channelType: "stream" },
      { id: "open-2", name: "retired", archived: true },
    ]),
  );
  expect(screen.getByRole("link", { name: "#release-notes" })).toHaveAttribute(
    "href",
    "buzz://channel/open-1",
  );
  expect(screen.getByRole("link", { name: "#design" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
});

it("lets the joined list own a name the directory also carries", () => {
  const h = session([{ id: "joined", name: "general" }]);
  render(<Body text="Ask in #general." session={h.session} />);
  act(() =>
    h.directoryRead([
      { id: "open-general", name: "general" },
      { id: "open-retired", name: "retired", archived: true },
    ]),
  );
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
  expect(screen.queryByRole("link", { name: "#retired" })).toBeNull();
  // Archiving the joined channel frees the name for the directory's open one.
  act(() => h.rename([{ id: "joined", name: "general", archived: true }]));
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/open-general",
  );
  // Leaving it does too.
  act(() => h.rename([]));
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/open-general",
  );
});
