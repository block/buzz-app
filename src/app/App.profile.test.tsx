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
import { requestSnapshotPreview } from "../features/agents/snapshot-preview";
import { createServices, type AppServices } from "./services";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter } from "../features/relay/events";
import { composerDOMFixture } from "../features/messages/composer-testing";
import type { ComposerInputElement } from "../features/messages/composer-dom";
import { sidebarFixtureState } from "./sidebar-plugin.fixture";

composerDOMFixture();

// jsdom has no IndexedDB; this flow keeps its message unsent.
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
      manifest: { id: "buzz.projects", name: "Projects", apiVersion: 1 },
      module: await import("../bundled/projects"),
    },
    {
      manifest: { id: "buzz.profiles", name: "Profiles", apiVersion: 1 },
      module: await import("../bundled/profiles"),
    },
    {
      manifest: { id: "test.sidebar", name: "Sidebar fixture", apiVersion: 1 },
      module: await import("./sidebar-plugin.fixture"),
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Community name" }),
    tags: [],
  },
  key,
);
const recipient = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Draft recipient" }),
    tags: [],
  },
  new Uint8Array(32).fill(7),
);
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  sidebarFixtureState.broken = true;
  sidebarFixtureState.onTarget = undefined;
  window.history.replaceState(null, "", "/");
});

async function setup(connectionError = false) {
  // jsdom has no media queries; responsive shell geometry is covered in browsers.
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
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local name", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session")) {
        if (connectionError) return new Response(null, { status: 502 });
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: origin,
          writeKinds: [9],
          directMessages: true,
        });
      }
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [profile, recipient].filter((event) =>
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
  await waitFor(() =>
    expect(current.relay.snapshot().status).toBe(
      connectionError ? "error" : "ready",
    ),
  );
  return user;
}

it("focuses an unavailable profile on first opening and returns focus after Escape", async () => {
  const user = await setup(true);
  await user.click(
    await screen.findByRole("button", { name: "Open Settings" }),
  );
  await screen.findByRole("region", { name: "Settings" });
  const trigger = screen.getByRole("button", { name: "Your profile" });
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  expect(
    within(menu).getByRole("menuitem", { name: "View your profile" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  const panel = screen.getByRole("complementary", { name: "Profile" });
  expect(panel).toHaveTextContent(
    "Connect to a community to view this profile.",
  );
  expect(panel).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("renders an owned page sidebar with the current target and isolates its failure", async () => {
  const user = await setup();
  sidebarFixtureState.broken = true;
  await act(async () => {
    await services?.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.sidebar",
      pageId: "main",
      route: { version: 1, params: "first" },
    });
  });
  expect(await screen.findByText("Beacon page content")).toBeVisible();
  expect(
    screen.getByRole("complementary", { name: "Beacon sidebar" }),
  ).toHaveTextContent("main:first");
  const sidebarDraft = screen.getByRole("textbox", { name: "Sidebar draft" });
  await user.type(sidebarDraft, "keep this draft");
  expect(
    within(
      screen.getByRole("complementary", { name: "Beacon sidebar" }),
    ).getByRole("navigation", { name: "Pages" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hide Beacon sidebar" }),
  ).toBeVisible();

  await act(async () => {
    await services?.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.sidebar",
      pageId: "main",
      route: { version: 1, params: "second" },
    });
  });
  expect(
    await within(
      screen.getByRole("complementary", { name: "Beacon sidebar" }),
    ).findByText("main:second"),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Sidebar draft" })).toHaveValue(
    "keep this draft",
  );
  expect(screen.getByRole("textbox", { name: "Sidebar draft" })).toBe(
    sidebarDraft,
  );

  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => {
      await services?.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params: "broken-sidebar" },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This page’s sidebar is unavailable.",
    );
    expect(screen.getByText("Beacon page content")).toBeVisible();
    expect(screen.getByRole("button", { name: "Your profile" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeVisible();

    await act(async () => {
      await services?.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params: "recovered" },
      });
    });
    expect(
      await screen.findByRole("complementary", { name: "Beacon sidebar" }),
    ).toHaveTextContent("main:recovered");

    await act(async () => {
      await services?.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "plain",
      });
    });
    expect(await screen.findByText("Plain page content")).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "Channel sidebar" }),
    ).toBeVisible();

    await act(async () => {
      await services?.navigation.open({ version: 1, kind: "settings" });
    });
    expect(
      await screen.findByRole("region", { name: "Settings" }),
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "Settings sidebar" }),
    ).toBeVisible();

    await act(async () => {
      await services?.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "broken",
      });
    });
    expect(await screen.findByText("Broken Beacon page content")).toBeVisible();
    const fallback = screen.getByRole("complementary", {
      name: "Broken Beacon sidebar",
    });
    expect(fallback).toContainElement(within(fallback).getByRole("alert"));
    expect(
      within(fallback).getByRole("navigation", { name: "Pages" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide Broken Beacon sidebar" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Your profile" })).toBeVisible();

    await act(async () => {
      await services?.plugins.change("disable", "test.sidebar");
    });
    sidebarFixtureState.broken = false;
    await act(async () => {
      await services?.plugins.change("enable", "test.sidebar");
    });
    expect(
      await screen.findByRole("complementary", {
        name: "Recovered Beacon sidebar",
      }),
    ).toBeVisible();
    expect(screen.getByText("Broken Beacon page content")).toBeVisible();
  } finally {
    error.mockRestore();
  }
});

it.each([
  {
    name: "rejected route parameters",
    params: 42,
    scope: undefined,
    reason: "unavailable",
  },
  {
    name: "a foreign viewer",
    params: "foreign-viewer",
    scope: { viewer: recipient.pubkey, communityOrigin: origin },
    reason: "denied",
  },
  {
    name: "an unjoined community",
    params: "unjoined-community",
    scope: { viewer, communityOrigin: "https://other.example" },
    reason: "denied",
  },
])("withholds a page sidebar for $name", async ({ params, scope, reason }) => {
  await setup();
  const current = services;
  if (!current) throw new Error("Missing services");
  const delivered = vi.fn();
  sidebarFixtureState.onTarget = delivered;
  await act(async () => {
    expect(
      await current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params },
        ...(scope !== undefined ? { scope } : {}),
      }),
    ).toMatchObject({ status: "failed", reason });
  });
  expect(
    await screen.findByRole("heading", {
      name: "This destination couldn’t open",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Beacon page content")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Beacon sidebar" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Pages" })).toBeVisible();
  expect(delivered).not.toHaveBeenCalled();
});

it("delivers a page sidebar target only after selecting its personal scope", async () => {
  await setup();
  const current = services;
  if (!current) throw new Error("Missing services");
  const observed: {
    selected: string | null;
    relayScope: string | undefined;
  }[] = [];
  sidebarFixtureState.onTarget = () => {
    observed.push({
      selected: current.communities.snapshot().selected,
      relayScope: current.relay.snapshot().scope,
    });
  };
  await act(async () => {
    expect(
      await current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params: "personal-space" },
        scope: null,
      }),
    ).toMatchObject({ status: "opened" });
  });
  expect(await screen.findByText("Beacon page content")).toBeVisible();
  expect(observed.length).toBeGreaterThan(0);
  for (const observation of observed) {
    expect(observation.selected).toBeNull();
    expect(observation.relayScope).toBeUndefined();
  }
});

it("opens the viewer's community profile from the account menu avatar", async () => {
  const user = await setup();
  const trigger = screen.getByRole("button", { name: "Your profile" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu", { name: "Community name" });
  await user.click(screen.getByRole("menuitem", { name: "View your profile" }));
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  const panel = await screen.findByRole("complementary", { name: "Profile" });
  expect(
    await within(panel).findByRole("heading", { name: "Community name" }),
  ).toBeVisible();
  // The panel takes focus itself; the closing menu must not pull it back.
  expect(
    within(panel).getByRole("region", { name: "Profile details" }),
  ).toHaveFocus();
  expect(
    within(panel).queryByRole("button", { name: "Message" }),
  ).not.toBeInTheDocument();
  await user.click(
    within(panel).getByRole("button", { name: "Close Profile panel" }),
  );
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("refocuses the retained profile on repeat openings and returns focus after Escape", async () => {
  const user = await setup();
  const trigger = screen.getByRole("button", { name: "Your profile" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "View your profile" }),
  );
  const panel = await screen.findByRole("complementary", { name: "Profile" });
  const details = within(panel).getByRole("region", {
    name: "Profile details",
  });
  const channels = within(panel).getByRole("tab", { name: "Channels" });
  await user.click(channels);

  for (const keyboard of [false, true]) {
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    // Base UI moves focus into an opened menu on the next animation frame.
    // Keys pressed before then reach the header trigger, which ignores Home.
    await waitFor(() =>
      expect(menu).toContainElement(document.activeElement as HTMLElement),
    );
    const viewProfile = within(menu).getByRole("menuitem", {
      name: "View your profile",
    });
    if (keyboard) {
      await user.keyboard("{Home}");
      expect(viewProfile).toHaveFocus();
      await user.keyboard("{Enter}");
    } else {
      await user.click(viewProfile);
    }
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    expect(within(panel).getByRole("region", { name: "Profile details" })).toBe(
      details,
    );
    expect(channels).toHaveAttribute("aria-selected", "true");
  }

  await user.keyboard("{Escape}");
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("opens the viewer's profile from New message without discarding recipients or the draft", async () => {
  const user = await setup();
  await user.click(await screen.findByRole("button", { name: "New message" }));
  const composing = await screen.findByRole("region", { name: "New message" });
  await user.click(
    await screen.findByRole("option", { name: "Draft recipient" }),
  );
  const editor = within(composing).getByRole<ComposerInputElement>("textbox", {
    name: "Message Draft recipient",
  });
  await user.click(editor);
  await user.type(editor, "Keep this unsent draft");
  const assertDraft = () => {
    expect(screen.getByRole("region", { name: "New message" })).toBe(composing);
    expect(
      within(composing).getByRole("textbox", {
        name: "Message Draft recipient",
      }),
    ).toBe(editor);
    expect(editor).toHaveTextContent("Keep this unsent draft");
    expect(
      within(composing).getByRole("button", { name: "Remove Draft recipient" }),
    ).toBeVisible();
  };

  const trigger = screen.getByRole("button", { name: "Your profile" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "View your profile" }),
  );
  const panel = await screen.findByRole("complementary", { name: "Profile" });
  expect(
    await within(panel).findByRole("heading", { name: "Community name" }),
  ).toBeVisible();
  assertDraft();

  await user.click(
    within(panel).getByRole("button", { name: "Close Profile panel" }),
  );
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  assertDraft();
  await user.click(editor);
  act(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
  await user.keyboard(" and keep editing");
  expect(editor).toHaveTextContent("Keep this unsent draft and keep editing");
});

it("mounts the received snapshot preview host without automatically importing", async () => {
  const user = await setup();
  await screen.findByRole("button", { name: "Your profile" });
  const current = services;
  if (!current) throw new Error("Missing services");
  const connection = current.relay.snapshot();
  if (connection.status !== "ready") throw new Error("Missing ready session");
  const create = vi.fn();
  Object.assign(current.agentControl, { create });
  act(() =>
    requestSnapshotPreview(connection.session, {
      url: `${origin}/media/${"a".repeat(64)}.png`,
      name: "helper.agent.png",
      kind: "image",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Preview snapshot",
  });
  expect(dialog).toHaveTextContent("Preview snapshot");
  expect(create).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Preview snapshot" }),
    ).not.toBeInTheDocument(),
  );
  expect(create).not.toHaveBeenCalled();
});
