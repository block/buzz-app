// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import { createRelaySession } from "../../features/relay/session";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { createCorpus } from "./corpus";
import { FinderDialog, type FinderScope } from "./FinderDialog";
import { startFinderSync } from "./sync";

const stops: (() => void)[] = [];
beforeEach(() => {
  // These tests cover semantic state. Browser inspection covers preview geometry.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
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
    value() {},
  });
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function fixture() {
  const viewer = keypair(),
    relay = keypair(),
    author = keypair();
  const root = message(author, "crew", "Release planning", 1_700_000_000);
  const events: RelayEvent[] = [
    root,
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, author.pubkey]),
    metadata(relay, "public", "public", 1_700_000_000, [
      ["public"],
      ["t", "stream"],
    ]),
    message(author, "crew", "API release", Math.floor(Date.now() / 1000) - 10, [
      ["e", root.id, "", "reply"],
    ]),
    message(author, "crew", "api draft", 1_700_000_020),
    message(author, "public", "api public notes", 1_700_000_030),
  ];
  const reads: ReadFilter[] = [];
  const control: {
    hold?: Promise<void>;
    fail?: boolean;
    signal?: AbortSignal;
  } = {};
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) =>
            filter.search !== undefined ||
            (filter["#h"]?.includes("crew") && filter.kinds?.includes(9)),
        )
      ) {
        reads.push(...filters);
        if (signal) control.signal = signal;
        await control.hold;
        if (control.fail) throw new Error("Search unavailable");
      }
      return queryEvents(events, filters);
    },
  });
  stops.push(owner.dispose);
  await owner.session.channels.ensureList();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const sync = startFinderSync({
    session: owner.session,
    corpus,
    changed() {},
  });
  stops.push(sync.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sync.status().phase).toBe("ready");
  reads.length = 0;
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    corpus,
    revision: 0,
    session: owner.session,
    sync,
    openMessage: vi.fn(),
  };
  function Finder() {
    const [scope, setScope] = useState<FinderScope>();
    return (
      <FinderDialog
        {...props}
        currentChannelId="crew"
        scope={scope}
        onScopeChange={setScope}
      />
    );
  }
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const click = async (element: HTMLElement) => {
    const clicked = user.click(element);
    // RTL drains its async wrapper on a zero-delay timer too.
    await vi.advanceTimersByTimeAsync(0);
    await clicked;
  };
  return { props, Finder, click, reads, control, corpus, events, root };
}
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const type = (value: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });

test("offers All of Buzz only after three letters, makes no default search, and reads once per pause", async () => {
  const { Finder, click, reads } = await fixture();
  render(
    <StrictMode>
      <Finder />
    </StrictMode>,
  );
  for (const value of ["", "ap", "api de", "🚀a"]) {
    type(value);
    expect(
      screen.queryByRole("option", { name: /Search all of Buzz/ }),
    ).not.toBeInTheDocument();
  }
  type("api");
  await tick(1000);
  expect(reads).toHaveLength(0);
  await click(screen.getByRole("option", { name: /Search all of Buzz/ }));
  expect(
    screen.getByRole("button", { name: "Remove All of Buzz search scope" }),
  ).toBeVisible();
  type("apix");
  await tick(SEARCH_DEBOUNCE_MS - 1);
  expect(reads).toHaveLength(0);
  type("api");
  await tick(SEARCH_DEBOUNCE_MS - 1);
  expect(reads).toHaveLength(0);
  await tick(1);
  expect(reads).toHaveLength(1);
  expect(screen.getByRole("option", { name: /API release/ })).toBeVisible();
  expect(screen.getByRole("combobox")).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: /API release/ }).id,
  );
  await tick(1000);
  expect(reads).toHaveLength(1);
  await click(
    screen.getByRole("button", { name: "Remove All of Buzz search scope" }),
  );
  type("api draft");
  await tick(1000);
  expect(reads).toHaveLength(1);
});

test("ranks relay hits, keeps public previews out of the index, and retains results through loading and retry", async () => {
  const { Finder, click, control, corpus, root } = await fixture();
  render(<Finder />);
  type("API");
  await click(screen.getByRole("option", { name: /Search all of Buzz/ }));
  await tick(SEARCH_DEBOUNCE_MS);
  const matches = () =>
    within(screen.getByRole("group", { name: "Matches" })).getAllByRole(
      "option",
    );
  expect(matches().map((row) => row.textContent)).toEqual([
    expect.stringContaining("API release"),
    expect.stringContaining("api public notes"),
    expect.stringContaining("api draft"),
  ]);
  expect(corpus.search("API").hits[0]?.doc.threadRootId).toBe(root.id);
  expect(corpus.search("").hits.map(({ doc }) => doc.channelId)).toEqual([
    "crew",
    "crew",
  ]);
  let release = () => {};
  control.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    type("missing");
    await tick(SEARCH_DEBOUNCE_MS);
    expect(matches()).toHaveLength(3);
    expect(screen.queryByText("Searching Buzz…")).not.toBeInTheDocument();
    await tick(1000);
    expect(screen.getByRole("status")).toHaveTextContent("Searching Buzz…");
    control.fail = true;
    await act(async () => release());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Messages could not load.",
    );
    expect(matches()).toHaveLength(3);
    control.fail = false;
    await click(screen.getByRole("button", { name: "Retry" }));
    await tick(SEARCH_DEBOUNCE_MS);
    expect(
      screen.getByText(/No messages in Buzz match “missing”/),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  } finally {
    release();
  }
});

test.each(["close", "scope", "session"])(
  "cancels a pending channel read on %s and ignores its late result",
  async (action) => {
    const { props, click, control, reads, corpus } = await fixture();
    let release = () => {};
    control.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onScopeChange = vi.fn();
    const view = render(
      <FinderDialog
        {...props}
        currentChannelId="crew"
        scope="channel"
        onScopeChange={onScopeChange}
      />,
    );
    try {
      await tick(0);
      expect(reads).toHaveLength(1);
      const signal = control.signal;
      if (action === "close")
        view.rerender(
          <FinderDialog
            {...props}
            open={false}
            currentChannelId="crew"
            scope="channel"
            onScopeChange={onScopeChange}
          />,
        );
      else if (action === "scope") {
        await click(
          screen.getByRole("button", {
            name: "Remove This channel search scope",
          }),
        );
        expect(onScopeChange).toHaveBeenCalledWith(undefined);
        view.rerender(
          <FinderDialog
            {...props}
            currentChannelId="crew"
            scope={undefined}
            onScopeChange={onScopeChange}
          />,
        );
      } else {
        props.sync.dispose();
        view.rerender(
          <FinderDialog
            {...props}
            session={undefined}
            sync={undefined}
            currentChannelId="crew"
            scope="channel"
            onScopeChange={onScopeChange}
          />,
        );
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => release());
      await tick(1000);
      expect(reads).toHaveLength(1);
      expect(corpus.size).toBe(0);
    } finally {
      release();
    }
  },
);
