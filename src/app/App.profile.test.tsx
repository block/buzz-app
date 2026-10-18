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
import type { ComposerInputElement } from "../features/messages/composer-dom";
import { composerDOMFixture } from "../features/messages/composer-testing";

composerDOMFixture();

// jsdom has no IndexedDB; this flow keeps its message unsent.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("../bundled", async () => {
  const profiles = await import("../bundled/profiles");
  const { Input } = await import("../shared/design-system/ui/Input");
  return {
    bundledPlugins: [
      {
        manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
        module: await import("../bundled/channels"),
      },
      {
        manifest: { id: "buzz.repos", name: "Repositories", apiVersion: 1 },
        module: await import("../bundled/repos"),
      },
      {
        manifest: { id: "buzz.profiles", name: "Profiles", apiVersion: 1 },
        module: {
          ...profiles,
          apply(ctx) {
            profiles.apply(ctx);
            ctx.panels.register({
              id: "draft-companion",
              title: "Draft companion",
              matches: (target) => target === "fixture:companion",
              launcher: { icon: "/buzz-mark.svg", target: "fixture:companion" },
              component: () => <Input aria-label="Companion note" />,
            });
          },
        } satisfies import("../plugins/api").PluginModule,
      },
    ],
  };
});
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

it("opens profile settings from the account menu header", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  const menu = await screen.findByRole("menu", { name: "Community name" });
  await user.click(
    within(menu).getByRole("menuitem", {
      name: "Community name, edit profile",
    }),
  );
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    await within(settings).findByText(
      "Update this community’s profile. Other community profiles stay unchanged.",
    ),
  ).toBeVisible();
  await within(settings).findByRole("textbox", { name: "Display name" });
  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  if (!services) throw new Error("Missing services");
  await act(async () => {
    void services?.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  const reopened = screen.getByRole("dialog", { name: "Settings" });
  expect(
    within(reopened).getByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Community name");
  expect(within(reopened).queryByText(/Loading your profile/)).toBeNull();
});

it("opens Plugins from the account menu and switches back to profile settings", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    await within(settings).findByRole("region", {
      name: "Manage plugins",
    }),
  ).toBeVisible();
  await user.click(within(settings).getByRole("button", { name: "Profile" }));
  expect(
    await within(settings).findByRole("region", {
      name: "Profile",
    }),
  ).toBeVisible();
});

it("keeps the same unsent conversation and companion panel through Settings sections and Close", async () => {
  const user = await setup();
  if (!services) throw new Error("Missing app services");
  const current = services;
  await user.click(await screen.findByRole("button", { name: "New message" }));
  const composing = await screen.findByRole("region", { name: "New message" });
  await user.click(
    await screen.findByRole("option", { name: "Draft recipient" }),
  );
  const editor = within(composing).getByRole<ComposerInputElement>("textbox", {
    name: "Message Draft recipient",
  });
  await user.click(editor);
  await user.paste("Keep this draft behind Settings");
  await user.click(screen.getByRole("button", { name: "Draft companion" }));
  const panel = await screen.findByRole("complementary", {
    name: "Draft companion",
  });
  const note = within(panel).getByRole("textbox", { name: "Companion note" });
  await user.type(note, "Retain companion state");
  const trigger = screen.getByRole("button", { name: "Your profile" });
  const entry = current.navigation.snapshot().entry;
  const assertPreserved = () => {
    expect(composing).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(
      within(panel).getByRole("textbox", {
        name: "Companion note",
        hidden: true,
      }),
    ).toBe(note);
    expect(note).toHaveValue("Retain companion state");
    expect(
      within(composing).getByRole("textbox", {
        name: "Message Draft recipient",
        hidden: true,
      }),
    ).toBe(editor);
    expect(editor).toHaveTextContent("Keep this draft behind Settings");
  };
  const communities = screen.getByRole("navigation", { name: "Communities" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  const frame = modal.closest("[data-shell-dialog-frame]");
  expect(frame).not.toBeNull();
  const workspace = frame?.parentElement;
  expect(workspace).toContainElement(composing);
  expect(workspace).toContainElement(panel);
  // The community switcher lives in the app header, which the frame excludes.
  expect(workspace).not.toContainElement(communities);
  expect(modal.closest('[aria-hidden="true"], [inert]')).toBeNull();
  await waitFor(() =>
    expect(modal).toContainElement(document.activeElement as HTMLElement),
  );
  assertPreserved();
  await user.click(within(modal).getByRole("button", { name: "Appearance" }));
  await within(modal).findByRole("heading", { name: "Appearance" });
  await user.click(
    within(modal).getByRole("button", { name: "Notifications" }),
  );
  await within(modal).findByRole("heading", { name: "Notifications" });
  assertPreserved();
  await user.click(
    within(modal).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(current.navigation.snapshot().entry.id).toBe(entry.id);
  assertPreserved();
  expect(trigger).toHaveFocus();
});

it("returns keyboard-opened Settings to the same focused draft", async () => {
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
  await user.paste("Keyboard draft");
  await user.keyboard("{Control>},{/Control}");
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() =>
    expect(modal).toContainElement(document.activeElement as HTMLElement),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Keyboard draft");
});
