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
import type { ReadFilter } from "../features/relay/events";
import { composerDOMFixture } from "../features/messages/composer-testing";
import type { ComposerInputElement } from "../features/messages/composer-dom";

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
  window.history.replaceState(null, "", "/");
});

async function setup() {
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
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: origin,
          writeKinds: [9],
          directMessages: true,
        });
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
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  return user;
}

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
