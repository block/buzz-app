// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageProps } from "../features/pages/service";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

const state = vi.hoisted(() => ({
  firstReloads: 0,
  secondReloads: 0,
  firstConsumes: true,
  secondConsumes: true,
  crashReloads: 0,
  crashNow: false,
}));

function FirstPage({ navigation }: PageProps) {
  const [draft, setDraft] = useState("");
  useEffect(
    () =>
      navigation?.onReload?.(() => {
        if (!state.firstConsumes) return false;
        state.firstReloads++;
        return true;
      }),
    [navigation],
  );
  return (
    <div>
      <h1>First surface</h1>
      <input
        aria-label="First draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  );
}

function SecondPage({ navigation }: PageProps) {
  useEffect(
    () =>
      navigation?.onReload?.(() => {
        if (!state.secondConsumes) return false;
        state.secondReloads++;
        return true;
      }),
    [navigation],
  );
  return <h1>Second surface</h1>;
}

function CrashPage({ navigation }: PageProps) {
  const [broken, setBroken] = useState(false);
  // Deliberately register without effect cleanup to prove the error boundary
  // still blocks a crashed page from intercepting Reload Buzz.
  if (navigation && !broken && !state.crashNow) {
    navigation.onReload?.(() => {
      state.crashReloads++;
      return true;
    });
  }
  if (broken || state.crashNow) throw new Error("Surface render failure");
  return (
    <button type="button" onClick={() => setBroken(true)}>
      Crash surface
    </button>
  );
}

vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.surface-a", name: "Surface A", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "first",
            title: "First surface",
            primary: true,
            component: FirstPage,
          });
          ctx.pages.register({
            id: "crash",
            title: "Crash surface",
            component: CrashPage,
          });
        },
      },
    },
    {
      manifest: { id: "test.surface-b", name: "Surface B", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "second",
            title: "Second surface",
            primary: true,
            component: SecondPage,
          });
          ctx.pages.register({
            id: "plain",
            title: "Plain surface",
            primary: true,
            component: () => <h1>Plain surface</h1>,
          });
        },
      },
    },
  ],
}));

let services: AppServices | undefined;
let communityReloads: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.firstReloads = 0;
  state.secondReloads = 0;
  state.firstConsumes = true;
  state.secondConsumes = true;
  state.crashReloads = 0;
  state.crashNow = false;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
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

afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function start(page: { pluginId: string; pageId: string }) {
  const target = { version: 1, kind: "page", ...page };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  communityReloads = vi
    .spyOn(current.communities, "reload")
    .mockImplementation(() => {});
  render(<App services={current} />);
  return current;
}

function press(
  target: EventTarget = document.body,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: "r",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it("routes Reload Buzz only to the visible eligible surface, preserves drafts, and falls back elsewhere", async () => {
  const current = start({ pluginId: "test.surface-a", pageId: "first" });
  expect(
    await screen.findByRole("heading", { name: "First surface" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );

  const input = screen.getByRole("textbox", { name: "First draft" });
  input.focus();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Keep draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Visible surface A consumes Mod+R; surface B and communities.reload stay untouched.
  expect(press(input).defaultPrevented).toBe(true);
  expect(state.firstReloads).toBe(1);
  expect(state.secondReloads).toBe(0);
  expect(communityReloads).not.toHaveBeenCalled();
  expect(input).toHaveValue("Keep draft");

  // Repeat, IME composition, and local editor preventDefault keep ordinary shortcut rules.
  press(input, { repeat: true });
  press(input, { isComposing: true });
  press(input, { keyCode: 229 });
  press(input, { modifierAltGraph: true });
  const stopLocal = (event: KeyboardEvent) => event.preventDefault();
  input.addEventListener("keydown", stopLocal, { once: true });
  press(input);
  expect(state.firstReloads).toBe(1);
  expect(communityReloads).not.toHaveBeenCalled();

  // Navigating to surface B revokes surface A's handler and routes Reload to surface B only.
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.surface-b",
      pageId: "second",
    });
  });
  expect(
    await screen.findByRole("heading", { name: "Second surface" }),
  ).toBeVisible();
  press();
  expect(state.firstReloads).toBe(1);
  expect(state.secondReloads).toBe(1);
  expect(communityReloads).not.toHaveBeenCalled();

  // Returning false from the visible surface falls back to ordinary community reload.
  state.secondConsumes = false;
  press();
  expect(state.secondReloads).toBe(1);
  expect(communityReloads).toHaveBeenCalledTimes(1);

  // Navigating to a plain surface without onReload runs ordinary community reload.
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.surface-b",
      pageId: "plain",
    });
  });
  expect(
    await screen.findByRole("heading", { name: "Plain surface" }),
  ).toBeVisible();
  press();
  expect(state.firstReloads).toBe(1);
  expect(state.secondReloads).toBe(1);
  expect(communityReloads).toHaveBeenCalledTimes(2);
});

it("falls back to ordinary Reload behind Settings, modals, shadow modals, and error boundaries, and resumes after Settings", async () => {
  const current = start({ pluginId: "test.surface-a", pageId: "first" });
  expect(
    await screen.findByRole("heading", { name: "First surface" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );

  // Behind Settings, the retained page stays suspended and Reload hits communities.reload.
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
  press();
  expect(state.firstReloads).toBe(0);
  expect(communityReloads).toHaveBeenCalledTimes(1);

  // Closing Settings resumes the retained page's reload handler.
  act(() => {
    screen.getByRole("button", { name: "Close Settings" }).click();
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  press();
  expect(state.firstReloads).toBe(1);
  expect(communityReloads).toHaveBeenCalledTimes(1);

  // Behind an ordinary light-DOM modal dialog, the page does not intercept Reload.
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  try {
    press();
    expect(state.firstReloads).toBe(1);
    expect(communityReloads).toHaveBeenCalledTimes(2);
  } finally {
    modal.remove();
  }

  // Behind an open shadow-root modal dialog — whether focus is inside the shadow
  // root, on slotted light-DOM content, or outside on document.body — the page
  // does not intercept Reload, and resumes once the shadow modal closes.
  const host = document.createElement("div");
  const slottedButton = document.createElement("button");
  slottedButton.textContent = "Slotted action";
  host.append(slottedButton);
  const shadow = host.attachShadow({ mode: "open" });
  const shadowDialog = document.createElement("dialog");
  shadowDialog.setAttribute("open", "");
  const shadowButton = document.createElement("button");
  shadowButton.textContent = "Inside shadow modal";
  const slot = document.createElement("slot");
  shadowDialog.append(shadowButton, slot);
  shadow.append(shadowDialog);
  document.body.append(host);
  try {
    shadowButton.focus();
    press(shadowButton);
    expect(state.firstReloads).toBe(1);
    expect(communityReloads).toHaveBeenCalledTimes(3);

    slottedButton.focus();
    press(slottedButton);
    expect(state.firstReloads).toBe(1);
    expect(communityReloads).toHaveBeenCalledTimes(4);

    slottedButton.blur();
    press(document.body);
    expect(state.firstReloads).toBe(1);
    expect(communityReloads).toHaveBeenCalledTimes(5);
  } finally {
    host.remove();
  }
  // Once the shadow modal is dismissed, the visible page handles Reload again.
  press();
  expect(state.firstReloads).toBe(2);
  expect(communityReloads).toHaveBeenCalledTimes(5);

  // After a page crashes into PageBoundary, it cannot intercept Reload Buzz.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    act(() => {
      void current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.surface-a",
        pageId: "crash",
      });
    });
    const crashButton = await screen.findByRole("button", {
      name: "Crash surface",
    });
    press();
    expect(state.crashReloads).toBe(1);

    act(() => crashButton.click());
    expect(
      await screen.findByRole("heading", { name: "This page couldn’t open" }),
    ).toBeVisible();
    press();
    expect(state.crashReloads).toBe(1);
    expect(communityReloads).toHaveBeenCalledTimes(6);
  } finally {
    errorSpy.mockRestore();
  }
});

it("honors Reload Buzz remaps, plugin disable, and leaves Restart untouched", async () => {
  const current = start({ pluginId: "test.surface-a", pageId: "first" });
  expect(
    await screen.findByRole("heading", { name: "First surface" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );

  // Remapping app-reload moves surface reload to the new chord; old Mod+R does nothing.
  act(() =>
    current.shortcutBindings.set("app-reload", {
      key: "u",
      mod: true,
      shift: true,
    }),
  );
  expect(press().defaultPrevented).toBe(false);
  expect(state.firstReloads).toBe(0);
  expect(communityReloads).not.toHaveBeenCalled();

  expect(
    press(document.body, { key: "u", shiftKey: true }).defaultPrevented,
  ).toBe(true);
  expect(state.firstReloads).toBe(1);
  expect(communityReloads).not.toHaveBeenCalled();

  // Resetting restores default Mod+R.
  act(() => current.shortcutBindings.set("app-reload", null));
  press();
  expect(state.firstReloads).toBe(2);

  // Mod+Shift+R (app-restart) remains wired to window.location.reload(), never onReload.
  const restart = vi.fn();
  const originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: restart },
  });
  try {
    expect(press(document.body, { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(state.firstReloads).toBe(2);
    expect(communityReloads).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  }

  // Disabling the plugin revokes the surface reload handler and falls back to communities.reload.
  await act(async () => {
    await current.plugins.change("disable", "test.surface-a");
  });
  press();
  expect(state.firstReloads).toBe(2);
  expect(communityReloads).toHaveBeenCalledTimes(1);
});
