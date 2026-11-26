// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startDeviceIndex } from "../../features/search/device-index";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../../features/relay/testing";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { SearchResults } from "./SearchResults";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("shows this device's matches while typing, then the relay's other hits below them", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const known = message(viewer, "crew", "deploy rollback notes", 1700000050);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    known,
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      // Relay searches are scripted; every other read finds the channel.
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some(
            (filter) =>
              (!filter.kinds || filter.kinds.includes(event.kind)) &&
              (!filter.ids || filter.ids.includes(event.id)),
          ),
        ),
      );
    },
  });
  await owner.session.channels.ensureList();
  const index = startDeviceIndex({
    snapshot: () => ({
      status: "ready",
      generation: 1,
      scope: "community:viewer",
      session: owner.session,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData);
  await vi.advanceTimersByTimeAsync(5000);
  // The app already received this message, as opening #crew would.
  await owner.session.read([{ ids: [known.id], limit: 1 }]);
  const rows = () =>
    screen
      .queryAllByRole("option")
      .map((row) => row.textContent ?? "")
      .filter((text) => text.includes("rollback"));
  try {
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: () => {},
      deviceIndex: index,
    };
    const view = render(<SearchResults {...props} query="dplyrlbk" />);
    // Fuzzy letters find it on the key, before the relay is asked.
    expect(rows()).toEqual([expect.stringContaining("deploy rollback notes")]);
    expect(wire.pending).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="rollback" />);
    expect(rows()).toEqual([expect.stringContaining("deploy rollback notes")]);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await act(async () =>
      wire
        .next()
        .respond([
          message(viewer, "crew", "rollback runbook", 1700000100),
          known,
        ]),
    );
    expect(rows()).toEqual([
      expect.stringContaining("deploy rollback notes"),
      expect.stringContaining("rollback runbook"),
    ]);
  } finally {
    index.dispose();
    owner.dispose();
  }
});
