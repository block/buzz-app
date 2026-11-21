// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { matchesEvent } from "../features/relay/projection";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../features/relay/testing";
import type { ReadFilter } from "../features/relay/events";

// The app's own Channels and Workflows plugins, with Workflows off by default
// as src/bundled/index.ts declares it. With Workflows off, a workflow message
// offers no way to its workflow and nothing reads the definition.
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: (await import("../bundled/channels/manifest.json")).default,
      module: await import("../bundled/channels"),
      enabledByDefault: true,
    },
    {
      manifest: (await import("../bundled/workflows/manifest.json")).default,
      module: await import("../bundled/workflows"),
      enabledByDefault: false,
    },
  ],
}));

const origin = "https://community.example";
const channelId = "22222222-2222-4222-8222-222222222222";
const workflowId = "11111111-1111-4111-8111-111111111111";

// jsdom has no media queries or layout observer.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
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
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** The app opened on a thread whose reply the relay sent for a workflow that
 * the viewer can read, with the Workflows plugin turned off. A thread, because
 * a channel timeline's rows need real layout to paint. */
function start() {
  // The community's relay key, which is also its NIP-11 `self`.
  const relay = keypair();
  const me = keypair();
  const owner = keypair();
  const viewer = me.pubkey;
  const scope = { viewer, communityOrigin: origin };
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  // What a fresh profile saves. Without it, the client record above marks an
  // existing profile, whose missing Workflows flag is backfilled to On.
  localStorage.setItem(
    "buzzodz.plugins.v1",
    JSON.stringify({ version: 3, enabled: { "buzz.workflows": false } }),
  );
  const root = message(me, channelId, "Ship it?", 1_700_000_100);
  const sent = message(relay, channelId, "Release announced", 1_700_000_200, [
    ["e", root.id, "", "reply"],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", owner.pubkey],
    ["buzz:workflow-id", workflowId],
  ]);
  const events = [
    roster(relay, channelId, [viewer, owner.pubkey]),
    metadata(relay, channelId, "Releases"),
    root,
    sent,
    // Another member's workflow in a channel the viewer belongs to.
    signed(owner, {
      kind: 30620,
      content: `name: Release announcer
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    text: Release announced
`,
      tags: [
        ["h", channelId],
        ["d", workflowId],
      ],
    }),
  ];
  const head = bounds(relay, channelId, "head", {
    has_more: false,
    next_cursor: null,
  });
  /** Every read that asked for workflow definitions. */
  const definitionReads: ReadFilter[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: relay.pubkey,
          archiveAuthority: relay.pubkey,
          relayUrl: origin,
        });
      if (!url.endsWith("/query")) return Response.json({});
      const filters = JSON.parse(String(options?.body)) as ReadFilter[];
      if (filters.some((filter) => filter.kinds?.includes(30620)))
        definitionReads.push(filters);
      const found = events.filter((event) =>
        filters.some(
          (filter) =>
            // The thread has one page: nothing is older than its only reply.
            filter.thread_cursor === undefined && matchesEvent(event, filter),
        ),
      );
      return Response.json(
        filters.some((filter) => filter.kinds?.includes(9))
          ? [...found, head]
          : found,
      );
    }),
  );
  const thread = {
    version: 1,
    kind: "conversation",
    scope,
    channelId,
    messageId: root.id,
    threadRootId: root.id,
  } as const;
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(thread))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return {
    current,
    scope,
    thread,
    route: { owner: owner.pubkey, id: workflowId },
    definitionReads,
  };
}

const WORKFLOW_CARD =
  "Workflow message" +
  "Sent automatically by a workflow. Its owner set it up but didn’t send this message personally.";

it("offers no View workflow and reads no definition while Workflows is turned off, then offers it and opens the workflow once Workflows is turned on", async () => {
  const { current, scope, thread, route, definitionReads } = start();
  const user = userEvent.setup();
  const workflowsPage = () =>
    current.pages
      .snapshot()
      .some((page) => page.key === "buzz.workflows/workflows");
  const onMessage = async () => {
    await waitFor(() =>
      expect(current.navigation.snapshot()).toMatchObject({
        status: "opened",
        entry: { target: thread },
      }),
    );
    expect(await screen.findByText("Release announced")).toBeVisible();
  };
  const openCard = async () => {
    screen.getByRole("button", { name: "Workflow message details" }).focus();
    await user.keyboard("{Enter}");
    return screen.findByRole("dialog", { name: "Workflow message" });
  };

  await onMessage();
  const opener = current.navigation.snapshot().entry.id;
  // Workflows is installed and off: it has no page to open.
  const configuration = current.plugins.snapshot().configuration;
  expect(
    configuration.status === "ready" &&
      configuration.catalog.plugins.map(({ manifest, enabled }) => [
        manifest.id,
        enabled,
      ]),
  ).toEqual([
    ["buzz.channels", true],
    ["buzz.workflows", false],
  ]);
  expect(workflowsPage()).toBe(false);

  // The message still says a workflow sent it, and its card is the card
  // without the action: no link, no placeholder, and no definition read for
  // a workflow this viewer could read.
  const off = await openCard();
  await act(async () => {});
  expect(off.textContent).toBe(WORKFLOW_CARD);
  expect(within(off).queryByRole("button")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Workflow message" }),
    ).toBeNull(),
  );
  expect(definitionReads).toEqual([]);
  expect(current.navigation.snapshot().entry.id).toBe(opener);

  // Turned on from Manage plugins, with the message still behind Settings.
  act(
    () =>
      void current.navigation.open({
        version: 1,
        kind: "settings",
        section: "plugins",
        pluginId: "buzz.workflows",
        scope,
      }),
  );
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(
    within(
      await within(settings).findByRole("complementary", {
        name: "Workflows details",
      }),
    ).getByRole("button", { name: "Enable" }),
  );
  await waitFor(() => expect(workflowsPage()).toBe(true));
  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await onMessage();
  // Turning the plugin on read nothing by itself.
  expect(definitionReads).toEqual([]);

  // Now the card's one lookup finds the workflow, and the action is offered.
  const card = await openCard();
  await user.click(
    await within(card).findByRole("button", { name: "View workflow" }),
  );
  expect(definitionReads[0]).toEqual([
    { kinds: [30620], authors: [route.owner], "#d": [route.id], limit: 1 },
  ]);

  // It opens the Workflows page at that workflow.
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: {
          version: 1,
          kind: "page",
          scope,
          pluginId: "buzz.workflows",
          pageId: "workflows",
          route: { version: 1, params: route },
        },
      },
    }),
  );
  expect(
    await within(
      await screen.findByRole("region", { name: "Workflow details" }),
    ).findByRole("tab", { name: "Release announcer" }),
  ).toBeVisible();
  // Another member's workflow, so the default My workflows filter gave way.
  expect(
    screen.getByRole("button", { name: /^Open Release announcer:/ }),
  ).toHaveAttribute("aria-pressed", "true");
  // The card's lookup, then the landing's batch read for this visit.
  expect(definitionReads.slice(1)).toEqual([
    [{ kinds: [30620], "#h": [channelId], limit: 100 }],
  ]);

  // The visit keeps its way back to the message.
  act(() => current.navigation.back());
  await onMessage();
  // Several navigations, each rendering the whole app again: about a second
  // apiece on a loaded runner, as in the Settings journeys in App.profile.
}, 15_000);
