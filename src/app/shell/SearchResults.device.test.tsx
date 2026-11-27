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
import type {
  DecisionRequest,
  DecisionResult,
  Decisions,
} from "../../features/decisions/service";
import { setMessageSortPreference } from "../../features/search/message-sort-preference";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { RERANK_WAIT } from "./message-rerank";
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
  setMessageSortPreference("relevance");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

/** #crew with one message this device already received, searched with the
 * device index on. Relay searches wait on the scripted wire. */
async function deviceSearch(options: { searchSort?: boolean } = {}) {
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
    ...(options.searchSort && { searchSort: true }),
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
  return {
    viewer,
    wire,
    known,
    props: {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLElement>(),
      pages: [],
      openNewMessage: () => {},
      openConversation: () => {},
      deviceIndex: index,
    },
    dispose() {
      index.dispose();
      owner.dispose();
    },
  };
}
const rows = () =>
  screen
    .queryAllByRole("option")
    .map((row) => row.textContent ?? "")
    .filter((text) => text.includes("rollback"));

it("shows this device's matches while typing, then the relay's other hits below them", async () => {
  const { viewer, wire, known, props, dispose } = await deviceSearch();
  try {
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
    dispose();
  }
});

it("leaves Most recent to the relay's order", async () => {
  setMessageSortPreference("newest");
  const { viewer, wire, known, props, dispose } = await deviceSearch({
    searchSort: true,
  });
  try {
    render(
      <SearchResults
        {...props}
        query="rollback"
        scopedChannelId="crew"
        onScopeChange={() => {}}
      />,
    );
    expect(rows()).toEqual([]);
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
      expect.stringContaining("rollback runbook"),
      expect.stringContaining("deploy rollback notes"),
    ]);
  } finally {
    dispose();
  }
});

it("adds the relay's hits once, reranked, or as they came when the rerank runs late", async () => {
  // Each call waits until the test answers it, favouring the runbook.
  const answers: (() => void)[] = [];
  const decisions = {
    status: () => "ready",
    subscribe: () => () => {},
    decide: (request: DecisionRequest) =>
      new Promise<DecisionResult>((resolve) => {
        const { candidates } = JSON.parse(request.state) as {
          candidates: { n: number; text: string }[];
        };
        answers.push(() =>
          resolve({
            outcome: "answered",
            backend: "test",
            model: "test",
            answers: Object.fromEntries(
              candidates.map(({ n, text }) => [
                `m${n}`,
                {
                  type: "yes_no",
                  probability: text.endsWith("runbook") ? 0.9 : 0.1,
                },
              ]),
            ),
          }),
        );
      }),
  } as unknown as Decisions;
  const { viewer, wire, known, props, dispose } = await deviceSearch();
  const relayHits = (query: string) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await wire
        .next()
        .respond([
          message(viewer, "crew", `${query} note`, 1700000200),
          message(viewer, "crew", `${query} runbook`, 1700000100),
          known,
        ]);
    });
  const device = [expect.stringContaining("deploy rollback notes")];
  try {
    const view = render(
      <SearchResults {...props} decisions={decisions} query="rollback" />,
    );
    await relayHits("rollback");
    // The relay's hits wait for the rerank, then join in its order.
    expect(rows()).toEqual(device);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => answers.shift()?.());
    expect(rows()).toEqual([
      expect.stringContaining("rollback runbook"),
      ...device,
      expect.stringContaining("rollback note"),
    ]);

    // A rerank past the wait lets them in as they came, and is dropped.
    view.rerender(
      <SearchResults {...props} decisions={decisions} query="rollbacks" />,
    );
    await relayHits("rollbacks");
    expect(rows()).toEqual(device);
    await act(async () => vi.advanceTimersByTimeAsync(RERANK_WAIT));
    const asCame = [
      ...device,
      expect.stringContaining("rollbacks note"),
      expect.stringContaining("rollbacks runbook"),
    ];
    expect(rows()).toEqual(asCame);
    await act(async () => answers.shift()?.());
    expect(rows()).toEqual(asCame);
  } finally {
    dispose();
  }
});
