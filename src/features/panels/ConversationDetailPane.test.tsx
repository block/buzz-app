// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConversationHost,
  type ConversationHostServices,
  type ConversationInteractions,
} from "../conversation/ConversationHost";
import {
  ConversationDetailPane,
  useConversationDetailPane,
} from "../conversation/ConversationDetailPane";
import type { RelaySession } from "../relay/session";
import type { RegisteredPanel } from "./service";

afterEach(cleanup);

// The conversation folder's tests are owned elsewhere; this covers the
// detail pane's contract from the panel side.
it("the detail pane has one owner: a reader's opening displaces another's", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const panel = {
    key: "fixture",
    id: "fixture",
    pluginId: "fixture",
    revision: "1",
    title: "Fixture",
    matches: () => true,
    component: ({ target }: { target: string }) => <p>Detail {target}</p>,
  } as unknown as RegisteredPanel;
  const viewer = "a".repeat(64);
  const scope = `wss://relay.test:${viewer}`;
  const session = {
    viewer,
    scope,
    directMessages: { available: false },
  } as unknown as RelaySession;
  const available = [panel];
  const host = {
    panels: {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: () => panel,
    },
    relay: { snapshot: () => ({ status: "ready", session, scope }) },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  const readers: Record<string, ConversationInteractions> = {};
  let shown = false;
  function Workspace() {
    const pane = useConversationDetailPane();
    shown = pane.open;
    return (
      <ConversationDetailPane value={pane.value}>
        {["first", "second"].map((id) => (
          <ConversationHost
            key={id}
            host={host}
            session={session}
            scope={scope}
            channelId={id}
            channelName={id}
          >
            {(interactions) => {
              readers[id] = interactions;
              return null;
            }}
          </ConversationHost>
        ))}
        {pane.companion}
      </ConversationDetailPane>
    );
  }
  render(<Workspace />);
  act(() => {
    readers.first?.onOpenLink("fixture:one");
  });
  expect(screen.getByText("Detail fixture:one")).toBeInTheDocument();
  act(() => {
    readers.second?.onOpenLink("fixture:two");
  });
  expect(screen.getByText("Detail fixture:two")).toBeInTheDocument();
  expect(screen.queryByText("Detail fixture:one")).not.toBeInTheDocument();
  expect(shown).toBe(true);
  // The displaced reader can open again and takes the pane back.
  act(() => {
    readers.first?.onOpenLink("fixture:three");
  });
  expect(screen.getByText("Detail fixture:three")).toBeInTheDocument();
  expect(screen.queryByText("Detail fixture:two")).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});
