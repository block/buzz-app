// @vitest-environment jsdom
// The Workflows page over the real session and channel store, started from
// the channel list an earlier run saved. The store publishes that list as
// read before the roster has confirmed any of it, with every channel
// `cached`, and the session refuses workflow reads for a cached channel.
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PageNavigation } from "../../features/navigation/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { HeadPersistence } from "../../features/relay/persistence";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { WorkflowsPage } from "./WorkflowsPage";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
const relay = keypair(),
  me = keypair(),
  owner = keypair();
const general = "11111111-1111-4111-8111-111111111111";
const releases = "22222222-2222-4222-8222-222222222222";
const workflowId = "33333333-3333-4333-8333-333333333333";
const definition = (author: typeof owner, name: string, id = workflowId) =>
  signed(author, {
    kind: 30620,
    created_at: 10,
    content: `name: ${name}\ntrigger:\n  on: message_posted\nsteps:\n  - id: notify\n    action: send_message\n    text: Announced\n`,
    tags: [
      ["h", releases],
      ["d", id],
    ],
  });
/** Another member's workflow: the default My workflows filter would hide it. */
const announcer = definition(owner, "Release announcer");
/** Both channels as an earlier run saved them, and as the relay lists them. */
const listed = [
  roster(relay, releases, [me.pubkey, owner.pubkey]),
  metadata(relay, releases, "Releases"),
  roster(relay, general, [me.pubkey]),
  metadata(relay, general, "General"),
];
const notFound = "Couldn’t find this workflow. It may have been deleted.";
const stalled =
  "Workflow data cleared or unavailable. Refresh to check access.";
const isRoster = (filters: readonly ReadFilter[]) =>
  filters.some((filter) => filter.kinds?.includes(39002));

const sessions: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
});

/** Starts a session from the saved `listed` channels against a relay holding
 * `events`, then shows the Workflows page: at `linked`, as a message's View
 * workflow opens it, or plainly. `holdRoster` keeps the relay's roster answer
 * back until `releaseRoster`; `failRoster` refuses the first roster read. */
async function start({
  events,
  linked,
  holdRoster = false,
  failRoster = false,
}: {
  /** Read on every query, so a test may change what the relay holds. */
  events: readonly RelayEvent[];
  linked?: RelayEvent;
  holdRoster?: boolean;
  failRoster?: boolean;
}) {
  const reads: (readonly ReadFilter[])[] = [];
  let releaseRoster = () => {};
  const rosterHeld = holdRoster
    ? new Promise<void>((resolve) => {
        releaseRoster = resolve;
      })
    : undefined;
  const persistence: HeadPersistence = {
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: listed,
      },
    }),
    writeStartup: async () => {},
    read: async () => [],
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close() {},
  };
  const connection = createRelaySession(
    {
      viewer: me.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters, signal) {
        reads.push(filters);
        if (isRoster(filters)) {
          if (failRoster && reads.filter(isRoster).length === 1)
            throw new Error("relay unavailable");
          await rosterHeld;
        }
        signal?.throwIfAborted();
        const found = filters.flatMap((filter) =>
          events
            .filter((event) => matchesEvent(event, filter))
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .slice(0, filter.limit),
        );
        return [...new Map(found.map((event) => [event.id, event])).values()];
      },
    },
    { prepared: true, persistence },
  );
  sessions.push(connection);
  // The relay service restores a session before it publishes it, so the page
  // first sees the saved list, not an empty one.
  await connection.restore();
  const { session } = connection;
  expect(
    session.channels
      .list()
      .channels.map((channel) => [channel.name, channel.cached]),
  ).toEqual([
    ["General", true],
    ["Releases", true],
  ]);
  const ready = {
    status: "ready",
    scope: session.scope,
    generation: 1,
    session,
    viewer: me.pubkey,
  };
  let visits = 0;
  /** The page for one visit: at `to`, as a message's View workflow opens it,
   * or plainly. */
  const page = (to?: RelayEvent) => (
    <ToastProvider>
      <WorkflowsPage
        relay={
          {
            snapshot: () => ready,
            subscribe: () => () => {},
          } as unknown as RelayData
        }
        navigation={
          to &&
          ({
            entryId: `visit-${++visits}`,
            target: {
              version: 1,
              kind: "page",
              pluginId: "buzz.workflows",
              pageId: "workflows",
              route: {
                version: 1,
                params: { owner: to.pubkey, id: workflowId },
              },
            },
            signal: new AbortController().signal,
          } as unknown as PageNavigation)
        }
      />
    </ToastProvider>
  );
  let shown = render(page(linked));
  return {
    /** A new visit to the page while it stays mounted, as the shell keeps it. */
    visit: (to?: RelayEvent) => shown.rerender(page(to)),
    /** The reader leaves the page, then comes back to it on a new visit. */
    revisit(to?: RelayEvent) {
      shown.unmount();
      shown = render(page(to));
    },
    releaseRoster,
    rosterReads: () => reads.filter(isRoster).length,
    /** The channels each workflow definition read named, in request order. */
    definitionReads: () =>
      reads.flatMap((filters) =>
        filters.flatMap((filter) =>
          filter.kinds?.includes(30620) ? [filter["#h"]] : [],
        ),
      ),
  };
}
const detailTab = (name: string) => screen.findByRole("tab", { name });

it.each([
  ["as soon as the roster confirms its channel", false],
  ["when the roster answers late", true],
])(
  "opens a linked workflow after a start from the saved channel list, %s",
  async (_when, holdRoster) => {
    const page = await start({
      events: [...listed, announcer],
      linked: announcer,
      holdRoster,
    });
    if (holdRoster) {
      // The roster read is out and unanswered. Nothing saved is read, and the
      // page says it is still reading channels: it neither calls the
      // community empty nor gives up on its workflows.
      await waitFor(() => expect(page.rosterReads()).toBe(1));
      expect(screen.getByRole("status")).toHaveTextContent("Reading channels…");
      expect(
        screen.queryByText("No channels are available in this community."),
      ).toBeNull();
      expect(page.definitionReads()).toEqual([]);
      page.releaseRoster();
    }
    expect(await detailTab("Release announcer")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Open Release announcer:/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // The landing's one batch for the two confirmed channels, and no more.
    expect(page.definitionReads()).toEqual([[general, releases]]);
    expect(screen.queryByText(stalled)).toBeNull();
  },
);

it("offers Retry channels when the roster read fails after a start from the saved channel list, then opens the linked workflow", async () => {
  const page = await start({
    events: [...listed, announcer],
    linked: announcer,
    failRoster: true,
  });
  const retry = await screen.findByRole("button", { name: "Retry channels" });
  expect(screen.getByRole("alert")).toHaveTextContent("relay unavailable");
  // The saved channels are still unconfirmed, so nothing was read for them.
  expect(page.definitionReads()).toEqual([]);
  expect(screen.queryByText(stalled)).toBeNull();
  fireEvent.click(retry);
  expect(await detailTab("Release announcer")).toBeVisible();
  expect(page.definitionReads()).toEqual([[general, releases]]);
});

it("says a linked workflow was not found once the roster confirms its channel and the workflow is gone", async () => {
  const page = await start({ events: listed, linked: announcer });
  expect(await screen.findByText(notFound)).toBeVisible();
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
  expect(page.definitionReads()).toEqual([[general, releases]]);
  expect(screen.queryByText(stalled)).toBeNull();
});

it("says a linked workflow was not found once the roster settles without its saved channel, and never reads that channel", async () => {
  // The viewer left Releases since the list was saved.
  const page = await start({
    events: [
      roster(relay, releases, [owner.pubkey], 1_700_000_100),
      ...listed.slice(1),
      announcer,
    ],
    linked: announcer,
  });
  expect(await screen.findByText(notFound)).toBeVisible();
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
  expect(page.definitionReads()).toEqual([[general]]);
});

it("loads the page's workflows on a plain visit after a start from the saved channel list", async () => {
  const page = await start({
    events: [...listed, definition(me, "Standup reminder")],
  });
  // A new row fades in, so its visibility is waited for.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Standup reminder:/ }),
    ).toBeVisible(),
  );
  expect(page.definitionReads()).toEqual([[general, releases]]);
  expect(screen.queryByText(stalled)).toBeNull();
  expect(screen.queryByText("Reading channels…")).toBeNull();
});

// The session keeps a batch answer for a few seconds, for the list. A linked
// visit is answered from reads made for it instead.
it.each([
  ["on the page it left a moment ago", "revisit"],
  ["on the page while it is still open", "visit"],
] as const)(
  "opens a workflow created after the page last read its channels, %s",
  async (_where, arrive) => {
    const events = [...listed, definition(me, "Standup reminder")];
    const page = await start({ events });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Open Standup reminder:/ }),
      ).toBeVisible(),
    );
    expect(page.definitionReads()).toEqual([[general, releases]]);
    // Another member creates a workflow, and its message links here.
    events.push(announcer);
    page[arrive](announcer);
    expect(await detailTab("Release announcer")).toBeVisible();
    expect(screen.queryByText(notFound)).toBeNull();
    // One more batch, read for the visit.
    expect(page.definitionReads()).toEqual([
      [general, releases],
      [general, releases],
    ]);
  },
);

it("does not open a linked workflow that was deleted after the page last read its channels", async () => {
  const events = [...listed, announcer, definition(me, "Standup reminder")];
  const page = await start({ events });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Standup reminder:/ }),
    ).toBeVisible(),
  );
  events.splice(events.indexOf(announcer), 1);
  const details: boolean[] = [];
  const watch = new MutationObserver(() =>
    details.push(!!screen.queryByRole("region", { name: "Workflow details" })),
  );
  watch.observe(document.body, { childList: true, subtree: true });
  try {
    page.revisit(announcer);
    expect(await screen.findByText(notFound)).toBeVisible();
  } finally {
    watch.disconnect();
  }
  // Not even while the visit's read was out.
  expect(details).not.toContain(true);
  expect(page.definitionReads()).toEqual([
    [general, releases],
    [general, releases],
  ]);
});

it("says a linked workflow was not found once the roster settles with no channel left for this page", async () => {
  // The viewer left both channels since the list was saved, so the landing
  // that reports a missing workflow never mounts.
  const page = await start({
    events: [
      roster(relay, releases, [owner.pubkey], 1_700_000_100),
      roster(relay, general, [owner.pubkey], 1_700_000_100),
      ...listed.filter((event) => event.kind !== 39002),
      announcer,
    ],
    linked: announcer,
  });
  expect(await screen.findByText(notFound)).toBeVisible();
  expect(
    screen.getByText("No channels are available in this community."),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
  expect(page.definitionReads()).toEqual([]);
});
