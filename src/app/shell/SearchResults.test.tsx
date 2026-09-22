// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../../features/relay/testing";
import { SearchResults } from "./SearchResults";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 9], // The real reader canonicalizes set order.
        "#h": ["crew"],
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(new ReadError("unavailable", "Relay read timed out")),
    );
    expect(
      screen.getByText(/Message search couldn’t finish: Relay read timed out/),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});
