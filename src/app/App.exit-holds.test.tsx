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
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { StrictMode } from "react";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter, RelayEvent } from "../features/relay/events";
import { composerDOMFixture } from "../features/messages/composer-testing";

composerDOMFixture();

// jsdom has no IndexedDB; nothing is sent in this flow.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
    {
      manifest: { id: "buzz.profiles", name: "Profiles", apiVersion: 1 },
      module: await import("../bundled/profiles"),
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example",
  other = "https://other.example";
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Community name" }),
    tags: [],
  },
  key,
);
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function setup() {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local name", picture: "" },
      memberships: [
        { id: origin, name: "Fixture community" },
        { id: other, name: "Other community" },
      ],
      selected: origin,
    }),
  );
  const events: RelayEvent[] = [profile];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session")) {
        const destination = decodeURIComponent(url.split("/")[3] ?? "");
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: destination.includes("other") ? other : origin,
          writeKinds: [9],
        });
      }
      if (url.endsWith("/query")) {
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
  const user = userEvent.setup();
  services = createServices();
  const current = services;
  render(
    <StrictMode>
      <App services={current} />
    </StrictMode>,
  );
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  let holds: string[] = [
    "The pop-out window for “Design” has an unsent reply.",
  ];
  const release = current.communities.holdExit(() => holds);
  const prompt = () =>
    screen.findByRole("alertdialog", { name: "Switch community?" });
  const noPrompt = () =>
    waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Switch community?" }),
      ).toBeNull(),
    );
  return {
    user,
    services: current,
    prompt,
    noPrompt,
    clearHolds: () => {
      holds = [];
    },
    release,
    selected: () => current.communities.snapshot().selected,
  };
}

it("asks before a direct community switch discards held work, and keeps or switches as chosen", async () => {
  const h = await setup();
  const after = vi.fn();
  expect(h.services.communities.select(other, { after })).toBe(false);
  const dialog = await h.prompt();
  expect(dialog).toHaveTextContent("has an unsent reply");
  await h.user.click(
    within(dialog).getByRole("button", { name: "Keep working" }),
  );
  await h.noPrompt();
  expect(h.selected()).toBe(origin);
  expect(after).not.toHaveBeenCalled();
  h.services.communities.select(other, { after });
  await h.user.click(
    within(await h.prompt()).getByRole("button", { name: "Switch anyway" }),
  );
  await h.noPrompt();
  await waitFor(() => expect(h.selected()).toBe(other));
  expect(after).toHaveBeenCalledTimes(1);
  // With nothing held, switching back asks nothing.
  h.clearHolds();
  expect(h.services.communities.select(origin)).toBe(true);
  expect(h.selected()).toBe(origin);
});

it("asks before a cross-community navigation commits, preserving the route on cancel", async () => {
  const h = await setup();
  const before = h.services.navigation.snapshot().entry;
  const target = {
    version: 1 as const,
    kind: "page" as const,
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: { viewer, communityOrigin: other },
  };
  let opening = h.services.navigation.open(target);
  const dialog = await h.prompt();
  await h.user.click(
    within(dialog).getByRole("button", { name: "Keep working" }),
  );
  await h.noPrompt();
  expect(h.selected()).toBe(origin);
  expect(h.services.navigation.snapshot().entry.id).toBe(before.id);
  expect(h.services.communities.pendingSelection()).toBeUndefined();
  await expect(opening).resolves.toMatchObject({ status: "cancelled" });
  opening = h.services.navigation.open(target);
  await h.user.click(
    within(await h.prompt()).getByRole("button", { name: "Switch anyway" }),
  );
  await h.noPrompt();
  await waitFor(() => expect(h.selected()).toBe(other));
  await opening;
  // Navigation within the same community asks nothing.
  await act(async () => {
    await h.services.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  expect(
    screen.queryByRole("alertdialog", { name: "Switch community?" }),
  ).toBeNull();
});

it("names unsaved Settings edits in the same prompt and asks only once", async () => {
  const h = await setup();
  await act(async () => {
    void h.services.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const name = await within(settings).findByRole("textbox", {
    name: "Display name",
  });
  await waitFor(() => expect(name).toHaveValue("Community name"));
  await h.user.clear(name);
  await h.user.type(name, "Unsaved name");
  h.services.communities.select(other, {
    after: () =>
      void h.services.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: { viewer, communityOrigin: other },
      }),
  });
  const dialog = await h.prompt();
  expect(dialog).toHaveTextContent("has an unsent reply");
  expect(dialog).toHaveTextContent("Your profile has unsaved changes.");
  await h.user.click(
    within(dialog).getByRole("button", { name: "Switch anyway" }),
  );
  await h.noPrompt();
  await waitFor(() => expect(h.selected()).toBe(other));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(
    screen.queryByRole("alertdialog", { name: "Discard changes?" }),
  ).toBeNull();
});
