// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPublicKey } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import type { OpenTarget } from "../features/navigation/targets";
import { matchesEvent } from "../features/relay/projection";
import { bounds, message, metadata, roster } from "../features/relay/testing";
import type { ReadFilter } from "../features/relay/events";
import { inboxTarget } from "../bundled/inbox/route";

vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
    {
      // Bestie's page needs the agents service.
      manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      module: await import("../bundled/agents"),
    },
    {
      manifest: { id: "buzz.inbox", name: "Activity", apiVersion: 1 },
      module: await import("../bundled/inbox"),
    },
    {
      manifest: { id: "buzz.bestie", name: "Bestie", apiVersion: 1 },
      module: await import("../bundled/bestie"),
    },
  ],
}));

const key = new Uint8Array(32).fill(7),
  viewer = getPublicKey(key),
  origin = "https://community.example",
  elsewhere = "https://elsewhere.example";
const author = { secret: key, pubkey: viewer };
const root = message(author, "alpha", "Thread root", 10);
const events = [
  roster(author, "alpha", [viewer]),
  metadata(author, "alpha", "Alpha"),
  root,
  bounds(author, "alpha", "head", { has_more: false, next_cursor: null }),
];

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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** The app with Messages, Activity and Bestie in the dock; `channel` serves
 * channel alpha with one thread root. */
function dockFixture({ channel = false } = {}) {
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    "buzzodz.plugins.v1",
    JSON.stringify({
      version: 3,
      enabled: { "buzz.bestie": true, "buzz.inbox": true },
    }),
  );
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [
        { id: origin, name: "Fixture community" },
        { id: elsewhere, name: "Elsewhere" },
      ],
      selected: origin,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: url.startsWith(elsewhere) ? elsewhere : origin,
        });
      if (url.endsWith("/query")) {
        if (!channel) return Response.json([]);
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}

const scope = (communityOrigin = origin) => ({ viewer, communityOrigin });
async function visit(current: AppServices, target: OpenTarget) {
  act(() => {
    void current.navigation.open(target);
  });
  await opened(current, target);
}
async function opened(current: AppServices, target: OpenTarget) {
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target },
    }),
  );
}
const activity: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
  scope: scope(),
};
const bestie = async () => {
  // With no agent yet, Bestie's dock app offers to create one.
  await userEvent.click(
    await screen.findByRole("tab", { name: "Create an agent" }),
  );
  await waitFor(() =>
    expect(current().navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target: { kind: "page", pluginId: "buzz.bestie" } },
    }),
  );
};
const current = () => {
  if (!services) throw new Error("No app");
  return services;
};
const messagesTab = () => screen.getByRole("tab", { name: "Messages" });

it("returns to Activity when the dock switches back to Messages", async () => {
  const app = dockFixture();
  await visit(app, activity);
  const visits = app.navigation.snapshot().entry.id;
  await bestie();
  await userEvent.click(messagesTab());
  await opened(app, activity);
  // Switching apps opens one new visit, as opening the bare page did.
  expect(app.navigation.snapshot().entry.id).not.toBe(visits);
  act(() => app.navigation.back());
  await waitFor(() =>
    expect(app.navigation.snapshot().entry.target).toMatchObject({
      pluginId: "buzz.bestie",
    }),
  );
});

// Activity's shortcuts and its preview footer open it with no scope; the
// dock returns there in the community it opened in.
it.each([
  [
    "its unread shortcut",
    () => userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}"),
    { route: { version: 1, params: { activity: "all", attention: "unread" } } },
  ],
  [
    "the preview footer's open",
    () =>
      act(() => {
        void current().navigation.open(inboxTarget);
      }),
    {},
  ],
])("returns to Activity opened by %s", async (_, enter, extra) => {
  const app = dockFixture();
  await waitFor(() => expect(app.navigation.snapshot().status).toBe("opened"));
  await enter();
  await waitFor(() =>
    expect(app.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target: { pluginId: "buzz.inbox", ...extra } },
    }),
  );
  expect(app.navigation.snapshot().entry.target).not.toHaveProperty("scope");
  await bestie();
  await userEvent.click(messagesTab());
  await opened(app, { ...activity, ...extra });
});

it("returns to the channel and its thread, without the one-time parts", async () => {
  const app = dockFixture({ channel: true });
  await visit(app, {
    version: 1,
    kind: "conversation",
    scope: scope(),
    channelId: "alpha",
    messageId: root.id,
    threadRootId: root.id,
  });
  await bestie();
  await userEvent.click(messagesTab());
  await opened(app, {
    version: 1,
    kind: "conversation",
    scope: scope(),
    channelId: "alpha",
    messageId: root.id,
    threadRootId: root.id,
  });
});

it("reselecting Messages from Activity still opens the channels root", async () => {
  const app = dockFixture();
  await visit(app, activity);
  await userEvent.click(messagesTab());
  await opened(app, {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: scope(),
  });
});

it("opens Messages' own page when the remembered place is in another community", async () => {
  const app = dockFixture();
  await visit(app, activity);
  // A visit scoped to another community selects that community.
  await visit(app, {
    version: 1,
    kind: "page",
    pluginId: "buzz.bestie",
    pageId: "bestie",
    scope: scope(elsewhere),
  });
  expect(app.communities.snapshot().selected).toBe(elsewhere);
  await userEvent.click(messagesTab());
  await opened(app, {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: scope(elsewhere),
  });
});
