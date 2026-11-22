// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import type {
  NavigationOpenOptions,
  NavigationSnapshot,
  OpenAttempt,
  OpenResult,
} from "../../features/navigation/controller";
import type { RegisteredPage } from "../../features/pages/service";
import type { RelaySession } from "../../features/relay/session";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import {
  BESTIE_PAGE,
  BestieConversationContext,
  bestieFocusRequests,
} from "./bestie-context";
import { DOCK_HINT, DOCK_HINT_ID, useDockKeys } from "./DockKeys";
import { GO_TO_DOCK, GO_TO_DOCK_EVENT } from "./dock-shortcut";
import { PageNavigation } from "./PageNavigation";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

const page = (key: string, title = key): RegisteredPage => {
  const [pluginId = key, id = key] = key.split("/");
  return {
    key,
    pluginId,
    id,
    title,
    revision: "1",
    primary: true,
    component: () => null,
  };
};
const BESTIE = page(BESTIE_PAGE, "Bestie");
const MESSAGES = page("buzz.channels/channels", "Messages");
const REMINDERS = page("buzz.reminders/reminders", "Reminders");
const many = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    page(`example.app${index}/app`, `App ${index + 1}`),
  );

let attempts = 0;
const attemptFor = (key: string): OpenAttempt => {
  attempts += 1;
  return {
    id: `attempt-${attempts}`,
    entry: {
      id: `entry-${attempts}`,
      target: { version: 1, kind: "page", pluginId: key, pageId: key },
    } as OpenAttempt["entry"],
    signal: new AbortController().signal,
  };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type Open = {
  key: string;
  options: Pick<NavigationOpenOptions, "focus" | "onAttempt"> | undefined;
  attempt: OpenAttempt;
  settle(result: OpenResult): Promise<void>;
};

function setup({
  pages = [BESTIE, MESSAGES, REMINDERS],
  desktop = true,
  platform = "Linux x86_64",
  conversation,
  extra,
}: {
  pages?: readonly RegisteredPage[];
  desktop?: boolean;
  platform?: string;
  conversation?: { session: RelaySession; channelId: string };
  extra?: ReactNode;
} = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(ctx, window, bindings);
  const client = { viewer: "viewer", selected: "community" as string | null };
  const relay = { session: {} as object };
  const communities = {
    subscribe: () => () => {},
    // Snapshots are immutable, as the service's are.
    snapshot: () => ({ ...client }),
    relay: { subscribe: () => () => {}, snapshot: () => relay },
  } as unknown as Communities;
  let current = attemptFor("start");
  const navigation = {
    snapshot: () => ({ attempt: current }) as NavigationSnapshot,
  };
  const opens: Open[] = [];
  const onSelect = vi.fn(
    (
      key: string,
      options?: Pick<NavigationOpenOptions, "focus" | "onAttempt">,
    ) => {
      const attempt = attemptFor(key);
      current = attempt;
      const result = deferred<OpenResult>();
      options?.onAttempt?.({ attempt, result: result.promise });
      opens.push({
        key,
        options,
        attempt,
        settle: async (settled) => {
          await act(async () => result.resolve(settled));
        },
      });
      return result.promise;
    },
  );
  let setPages: (next: readonly RegisteredPage[]) => void = () => {};
  function Harness() {
    const [live, set] = useState(pages);
    setPages = set;
    const dockKeys = useDockKeys({
      shortcuts,
      bindings,
      communities,
      navigation,
      pages: live,
      onSelect,
      desktop,
      platform,
    });
    return (
      <>
        <input aria-label="Draft" />
        <div className="shell-dock-pages">
          {/* The DM's unread badge needs a real session; the keys don't. */}
          <BestieConversationContext value={undefined}>
            <PageNavigation
              pages={live}
              selected=""
              onSelect={onSelect}
              placement="dock"
              dockKeys={dockKeys}
            />
          </BestieConversationContext>
          {dockKeys.active && (
            <span id={DOCK_HINT_ID} hidden>
              {DOCK_HINT}
            </span>
          )}
        </div>
        <main id="main-content" tabIndex={-1}>
          {live.map((item) => (
            <div
              key={item.key}
              id={`shell-page-${item.key}`}
              role="tabpanel"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Like the shell, the tabpanel takes focus when its page has no control to focus.
              tabIndex={0}
              aria-label={item.title}
            />
          ))}
        </main>
        {extra}
      </>
    );
  }
  render(
    <BestieConversationContext value={conversation}>
      <Harness />
    </BestieConversationContext>,
  );
  const tab = (name: string) => screen.getByRole("tab", { name });
  const draft = screen.getByRole("textbox", { name: "Draft" });
  return {
    shortcuts,
    bindings,
    client,
    relay,
    opens,
    onSelect,
    tab,
    draft,
    setPages: (next: readonly RegisteredPage[]) => act(() => setPages(next)),
    supersede: () => {
      current = attemptFor("elsewhere");
    },
    /** The destination resolves its address: same open, new attempt object. */
    resolveAddress: () => {
      current = Object.freeze({
        ...current,
        entry: { ...current.entry, id: `${current.entry.id}-resolved` },
      });
    },
  };
}

/** Ctrl+D off Apple, sent to the focused element as the dispatcher sees it. */
const ctrlD = (init: KeyboardEventInit = {}) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key,
    code: init.code ?? (key.length === 1 ? `Digit${key}` : key),
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};
const menuRequest = (browserSessionId: string | null) =>
  act(() => {
    window.dispatchEvent(
      new CustomEvent(GO_TO_DOCK_EVENT, { detail: { browserSessionId } }),
    );
  });
const numbers = () =>
  [...document.querySelectorAll(".buzz-tabs-key")].map(
    (marker) => marker.textContent,
  );

const contexts: Context[] = [];
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(true);
});
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  bestieFocusRequests.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("⌘D focuses Bestie, numbers the apps and describes the keys; nothing opens", () => {
  const { tab, draft, onSelect } = setup({ pages: [BESTIE, ...many(9)] });
  draft.focus();
  ctrlD();
  expect(tab("Bestie")).toHaveFocus();
  expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  expect(tab("Bestie")).toHaveAttribute("aria-keyshortcuts", "1");
  expect(tab("App 8")).toHaveAttribute("aria-keyshortcuts", "9");
  // The tenth app is reached with the arrows only.
  expect(tab("App 9")).not.toHaveAttribute("aria-keyshortcuts");
  expect(tab("App 9")).not.toHaveAttribute("aria-describedby");
  expect(tab("Bestie").getAttribute("aria-describedby")).toContain(
    DOCK_HINT_ID,
  );
  expect(document.getElementById(DOCK_HINT_ID)).toHaveTextContent(DOCK_HINT);
  expect(onSelect).not.toHaveBeenCalled();
});

it("a digit opens the nth app of the live order, matched by its physical key", async () => {
  const { tab, draft, onSelect, setPages } = setup();
  setPages([BESTIE, page("example.late/late", "Late"), MESSAGES, REMINDERS]);
  draft.focus();
  ctrlD();
  // A non-US layout: the key is "#" but the physical key is Digit3.
  const event = press("#", { code: "Digit3" });
  expect(event.defaultPrevented).toBe(true);
  expect(onSelect).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith(MESSAGES.key, {
    focus: "content",
    onAttempt: expect.any(Function),
  });
  expect(numbers()).toEqual([]);
  expect(tab("Late")).not.toHaveAttribute("aria-keyshortcuts");
});

it("Return opens the focused app with content focus; entering by Tab keeps the dock's own Return", () => {
  const { tab, draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  press("ArrowDown", { code: "ArrowDown" });
  tab("Messages").focus();
  const event = press("Enter", { code: "Enter" });
  expect(event.defaultPrevented).toBe(true);
  expect(onSelect).toHaveBeenCalledWith(MESSAGES.key, {
    focus: "content",
    onAttempt: expect.any(Function),
  });
  onSelect.mockClear();
  // Not in dock mode: the tab handles Return itself.
  tab("Reminders").focus();
  expect(press("Enter", { code: "Enter" }).defaultPrevented).toBe(false);
  expect(onSelect).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ focus: "content" }),
  );
});

it("Escape returns focus to where it was, or to the main content when that is gone", () => {
  const { tab, draft } = setup();
  draft.focus();
  ctrlD();
  press("Escape", { code: "Escape" });
  expect(draft).toHaveFocus();
  expect(numbers()).toEqual([]);

  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  ctrlD();
  expect(tab("Bestie")).toHaveFocus();
  field.remove();
  press("Escape", { code: "Escape" });
  expect(document.getElementById("main-content")).toHaveFocus();
});

it("Escape does not return to a field in another community", () => {
  const { draft, client } = setup();
  draft.focus();
  ctrlD();
  client.selected = "other";
  press("Escape", { code: "Escape" });
  expect(document.getElementById("main-content")).toHaveFocus();
});

it("Tab, a click or focus leaving the dock ends dock mode quietly", () => {
  const { tab, draft } = setup();
  draft.focus();
  ctrlD();
  act(() => draft.focus());
  expect(numbers()).toEqual([]);
  expect(draft).toHaveFocus();

  ctrlD();
  expect(numbers()).toHaveLength(3);
  act(() => {
    tab("Messages").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
  });
  expect(numbers()).toEqual([]);
});

it("a second ⌘D opens the focused app once; the tablist leaves modified keys alone", () => {
  const { tab, draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  tab("Reminders").focus();
  ctrlD();
  expect(onSelect).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith(REMINDERS.key, expect.anything());
});

it("modified, composing and AltGraph keys fall through in dock mode", () => {
  const { draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  for (const init of [
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    expect(press("2", init).defaultPrevented).toBe(false);
  const altGraph = new KeyboardEvent("keydown", {
    key: "2",
    code: "Digit2",
    bubbles: true,
    cancelable: true,
  });
  vi.spyOn(altGraph, "getModifierState").mockReturnValue(true);
  act(() => {
    document.activeElement?.dispatchEvent(altGraph);
  });
  expect(altGraph.defaultPrevented).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
  expect(numbers()).toHaveLength(3);
});

it("held keys open once: digit repeats and repeated ⌘D are dropped", () => {
  const { draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  ctrlD({ repeat: true });
  expect(onSelect).not.toHaveBeenCalled();
  expect(numbers()).toHaveLength(3);
  press("2");
  press("2", { repeat: true });
  press("2", { repeat: true });
  expect(onSelect).toHaveBeenCalledOnce();
});

it("a plugin page that doesn't take focus gets its tabpanel focused after it opens", async () => {
  const { draft, opens } = setup();
  draft.focus();
  ctrlD();
  press("2");
  // Pending: the dock leaves focus alone.
  expect(document.activeElement?.getAttribute("role")).toBe("tab");
  await opens[0]?.settle({ status: "opened" });
  expect(screen.getByRole("tabpanel", { name: "Messages" })).toHaveFocus();
});

it("a page that focused its own control keeps it", async () => {
  const { draft, opens } = setup();
  draft.focus();
  ctrlD();
  press("2");
  const own = document.createElement("button");
  document.getElementById(`shell-page-${MESSAGES.key}`)?.append(own);
  act(() => own.focus());
  await opens[0]?.settle({ status: "opened" });
  expect(own).toHaveFocus();
});

it("a click during the open cancels the tabpanel fallback", async () => {
  const { draft, opens } = setup();
  draft.focus();
  ctrlD();
  press("2");
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerdown"));
  });
  await opens[0]?.settle({ status: "opened" });
  expect(screen.getByRole("tabpanel", { name: "Messages" })).not.toHaveFocus();
});

it.each([
  ["failed", { status: "failed", reason: "unavailable" }, false],
  ["cancelled", { status: "cancelled" }, false],
  ["superseded", { status: "opened" }, true],
] as const)(
  "a %s open runs no fallback and leaves focus alone",
  async (_, result, supersede) => {
    const env = setup();
    env.draft.focus();
    ctrlD();
    press("2");
    const tab = document.activeElement;
    if (supersede) env.supersede();
    await env.opens[0]?.settle(result as OpenResult);
    expect(tab).toHaveFocus();
  },
);

it("an aborted attempt runs no fallback", async () => {
  const { draft, opens } = setup();
  draft.focus();
  ctrlD();
  press("2");
  const open = opens[0];
  const controller = new AbortController();
  if (open) Object.assign(open.attempt, { signal: controller.signal });
  controller.abort();
  await open?.settle({ status: "opened" });
  expect(screen.getByRole("tabpanel", { name: "Messages" })).not.toHaveFocus();
});

it("Bestie opens exactly once, preserving focus, for ⌘D ⌘D, Return and 1", async () => {
  const env = setup();
  for (const open of [
    () => ctrlD(),
    () => press("Enter", { code: "Enter" }),
    () => press("1"),
  ]) {
    env.onSelect.mockClear();
    env.draft.focus();
    ctrlD();
    open();
    expect(env.onSelect).toHaveBeenCalledOnce();
    expect(env.onSelect).toHaveBeenCalledWith(BESTIE_PAGE, {
      focus: "preserve",
      onAttempt: expect.any(Function),
    });
  }
});

it("an opened Bestie posts the composer request for its own attempt and DM", async () => {
  const session = {} as RelaySession;
  const { draft, opens } = setup({
    conversation: { session, channelId: "dm" },
  });
  draft.focus();
  ctrlD();
  ctrlD();
  expect(bestieFocusRequests.snapshot()).toBeUndefined();
  await opens[0]?.settle({ status: "opened" });
  const request = bestieFocusRequests.snapshot();
  expect(request).toMatchObject({
    attempt: opens[0]?.attempt,
    session,
    channelId: "dm",
  });
  expect(request?.inScope()).toBe(true);
  expect(request?.cancelled()).toBe(false);
  // A click after the press cancels it.
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerdown"));
  });
  expect(request?.cancelled()).toBe(true);
});

it.each([
  ["failed", { status: "failed", reason: "unavailable" }, false],
  ["superseded", { status: "opened" }, true],
] as const)(
  "a %s Bestie open posts no request",
  async (_, result, supersede) => {
    const env = setup({
      conversation: { session: {} as RelaySession, channelId: "dm" },
    });
    env.draft.focus();
    ctrlD();
    ctrlD();
    if (supersede) env.supersede();
    await env.opens[0]?.settle(result as OpenResult);
    expect(bestieFocusRequests.snapshot()).toBeUndefined();
  },
);

it("without a Bestie DM, ⌘D ⌘D opens the chooser with no composer request", async () => {
  const { draft, opens, onSelect } = setup();
  draft.focus();
  ctrlD();
  ctrlD();
  expect(onSelect).toHaveBeenCalledOnce();
  await opens[0]?.settle({ status: "opened" });
  expect(bestieFocusRequests.snapshot()).toBeUndefined();
});

it("without a Bestie page, ⌘D starts on the first app", () => {
  const { tab, draft } = setup({ pages: [MESSAGES, REMINDERS] });
  draft.focus();
  ctrlD();
  expect(tab("Messages")).toHaveFocus();
});

it("browser builds register nothing", () => {
  const { shortcuts, draft, onSelect } = setup({ desktop: false });
  expect(shortcuts.hostSnapshot().map(({ id }) => id)).not.toContain(
    GO_TO_DOCK,
  );
  draft.focus();
  ctrlD();
  expect(draft).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
});

it("off Apple, a shortcut saved on Ctrl+D before this version keeps it", () => {
  const { shortcuts, bindings, draft } = setup();
  const focusComposer = vi.fn();
  act(() => {
    shortcuts.registerHost({
      id: "focus-composer",
      title: "Focus message box",
      binding: { key: "l", mod: true },
      order: 10,
      allowInEditable: true,
      run: focusComposer,
    });
    bindings.set("focus-composer", { key: "d", mod: true });
  });
  draft.focus();
  ctrlD();
  expect(focusComposer).toHaveBeenCalledTimes(1);
  expect(draft).toHaveFocus();
  expect(shortcuts.resolved().get(GO_TO_DOCK)?.effective).toEqual([]);
});

it("off Apple, a terminal keeps Ctrl+D", () => {
  const terminal = (
    <div className="xterm">
      <textarea aria-label="Terminal" />
    </div>
  );
  setup({ extra: terminal });
  const field = screen.getByRole("textbox", { name: "Terminal" });
  field.focus();
  ctrlD();
  expect(field).toHaveFocus();
});

it("the tooltip shows the effective chord and follows a rebind", async () => {
  const { tab, bindings } = setup();
  act(() => tab("Messages").focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    /Messages.*Ctrl.*D.*2/,
  );
  act(() => bindings.set(GO_TO_DOCK, { key: "j", mod: true }));
  await waitFor(() =>
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Ctrl.*J.*2/),
  );
});

it("a browser build shows no chord in the tooltip", async () => {
  const { tab } = setup({ desktop: false });
  act(() => tab("Messages").focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent(/^Messages$/);
});

// macOS desktop: the native Window → Go to Dock item sends the request.
const mac = { platform: "MacIntel" };

it("the macOS menu request is refused behind a dialog: nothing moves and no native call", () => {
  const dialog = <div role="dialog" aria-modal="true" aria-label="Confirm" />;
  const { draft, onSelect } = setup({ ...mac, extra: dialog });
  draft.focus();
  menuRequest("guest-1");
  expect(draft).toHaveFocus();
  expect(invoke).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});

it("entering from a guest page asks for the main view only after the tab has focus", () => {
  const { tab } = setup(mac);
  let focusedAtCall: Element | null = null;
  invoke.mockImplementation(async () => {
    focusedAtCall = document.activeElement;
    return true;
  });
  menuRequest("guest-1");
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("focus_main_view");
  expect(focusedAtCall).toBe(tab("Bestie"));
});

it("entering from the app itself makes no native call", () => {
  const { tab, draft } = setup(mac);
  draft.focus();
  menuRequest(null);
  expect(tab("Bestie")).toHaveFocus();
  expect(invoke).not.toHaveBeenCalled();
});

function guestHost(id = "guest-1") {
  const host = document.createElement("div");
  host.dataset.browserSession = id;
  host.getClientRects = () =>
    [{ width: 10, height: 10 }] as unknown as DOMRectList;
  document.body.append(host);
  return host;
}

it("Escape returns to the same guest session while it is shown and in scope", async () => {
  setup(mac);
  const host = guestHost();
  menuRequest("guest-1");
  invoke.mockClear();
  press("Escape", { code: "Escape" });
  expect(invoke).toHaveBeenCalledWith("browser_focus", {
    sessionId: "guest-1",
  });
  host.remove();
});

it.each([
  ["removed", (host: HTMLElement) => host.remove()],
  ["hidden", (host: HTMLElement) => host.setAttribute("hidden", "")],
  [
    "out of scope",
    (_: HTMLElement, client: { selected: string | null }) => {
      client.selected = "other";
    },
  ],
] as const)(
  "Escape with the guest %s focuses the main content and makes no native call",
  (_, change) => {
    const { client } = setup(mac);
    const host = guestHost();
    menuRequest("guest-1");
    invoke.mockClear();
    change(host, client);
    press("Escape", { code: "Escape" });
    expect(invoke).not.toHaveBeenCalled();
    expect(document.getElementById("main-content")).toHaveFocus();
    host.remove();
  },
);

it("a refused guest focus falls back only for the current exit", async () => {
  setup(mac);
  const host = guestHost();
  const reply = deferred<boolean>();
  menuRequest("guest-1");
  invoke.mockImplementation(() => reply.promise);
  press("Escape", { code: "Escape" });
  await act(async () => reply.resolve(false));
  expect(document.getElementById("main-content")).toHaveFocus();

  // A second ⌘D before the reply: that exit no longer owns the fallback.
  invoke.mockResolvedValue(true);
  menuRequest("guest-1");
  const late = deferred<boolean>();
  invoke.mockImplementation(() => late.promise);
  press("Escape", { code: "Escape" });
  menuRequest("guest-1");
  await act(async () => late.resolve(false));
  expect(document.getElementById("main-content")).not.toHaveFocus();
  expect(document.activeElement?.getAttribute("role")).toBe("tab");
  host.remove();
});

it("a click that moves focus before the reply means no fallback", async () => {
  const { draft } = setup(mac);
  const host = guestHost();
  menuRequest("guest-1");
  const reply = deferred<boolean>();
  invoke.mockImplementation(() => reply.promise);
  press("Escape", { code: "Escape" });
  act(() => draft.focus());
  await act(async () => reply.resolve(false));
  expect(draft).toHaveFocus();
  host.remove();
});

it("a held Return opens once; its repeats and release stay with the dock until it is let go", async () => {
  const { tab, draft, onSelect, opens } = setup();
  draft.focus();
  ctrlD();
  tab("Messages").focus();
  press("Enter", { code: "Enter" });
  expect(onSelect).toHaveBeenCalledOnce();
  // Dock mode has ended, but the tab still has focus while the open is
  // pending: a repeat must not click it into a second, preserving open.
  const clicked = vi.fn();
  tab("Messages").addEventListener("keydown", clicked);
  for (const key of ["Enter", "Enter"]) {
    const repeat = press(key, { code: "Enter", repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
  }
  expect(clicked).not.toHaveBeenCalled();
  const release = new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    tab("Messages").dispatchEvent(release);
  });
  expect(release.defaultPrevented).toBe(true);
  expect(onSelect).toHaveBeenCalledOnce();
  await opens[0]?.settle({ status: "opened" });
  expect(screen.getByRole("tabpanel", { name: "Messages" })).toHaveFocus();
  // Released: the next Return is an ordinary key again.
  tab("Reminders").focus();
  expect(press("Enter", { code: "Enter" }).defaultPrevented).toBe(false);
});

it("a held Space opens once and its release does not reach the tab", () => {
  const { tab, draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  press(" ", { code: "Space" });
  expect(onSelect).toHaveBeenCalledOnce();
  const keyup = vi.fn();
  tab("Bestie").addEventListener("keyup", keyup);
  press(" ", { code: "Space", repeat: true });
  act(() => {
    tab("Bestie").dispatchEvent(
      new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }),
    );
  });
  expect(keyup).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledOnce();
});

it("a fresh press after a release elsewhere is not held", () => {
  const { draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  press("2");
  expect(onSelect).toHaveBeenCalledOnce();
  // The release went to another view: the next 2 is the field's own.
  act(() => draft.focus());
  expect(press("2").defaultPrevented).toBe(false);
  expect(press("2", { repeat: true }).defaultPrevented).toBe(false);
  expect(onSelect).toHaveBeenCalledOnce();
});

it("a page that resolves its address before it opens still gets its tabpanel focused", async () => {
  const { draft, opens, resolveAddress } = setup();
  draft.focus();
  ctrlD();
  press("2");
  resolveAddress();
  await opens[0]?.settle({ status: "opened" });
  expect(screen.getByRole("tabpanel", { name: "Messages" })).toHaveFocus();
});

it.each([
  ["gone", (panel: HTMLElement) => panel.remove()],
  ["hidden", (panel: HTMLElement) => panel.setAttribute("hidden", "")],
  ["inert", (panel: HTMLElement) => panel.setAttribute("inert", "")],
])("an open whose panel is %s leaves focus alone", async (_, change) => {
  const { draft, opens } = setup();
  draft.focus();
  ctrlD();
  press("2");
  const tabFocused = document.activeElement;
  const panel = document.getElementById(`shell-page-${MESSAGES.key}`);
  if (panel) change(panel);
  await opens[0]?.settle({ status: "opened" });
  expect(document.activeElement).toBe(tabFocused);
});

it("removing the focused tab ends dock mode, and ⌘D starts again", async () => {
  const { tab, draft, setPages } = setup();
  draft.focus();
  ctrlD();
  expect(tab("Bestie")).toHaveFocus();
  // jsdom, like WebKit, sends no focusout when the focused element goes.
  const focusout = vi.fn();
  document.addEventListener("focusout", focusout, true);
  setPages([MESSAGES, REMINDERS]);
  await waitFor(() => expect(numbers()).toEqual([]));
  expect(focusout).not.toHaveBeenCalled();
  ctrlD();
  expect(tab("Messages")).toHaveFocus();
  expect(numbers()).toEqual(["1", "2"]);
});

it("⌘D in dock mode with focus outside the dock starts again instead of doing nothing", () => {
  const { tab, draft, onSelect } = setup();
  draft.focus();
  ctrlD();
  // Focus moves away with no focusout reaching the dock.
  const swallow = (event: Event) => event.stopPropagation();
  document.addEventListener("focusout", swallow, true);
  act(() => draft.focus());
  document.removeEventListener("focusout", swallow, true);
  expect(numbers()).toHaveLength(3);
  ctrlD();
  expect(onSelect).not.toHaveBeenCalled();
  expect(tab("Bestie")).toHaveFocus();
  expect(numbers()).toHaveLength(3);
});

it("a refused main-view focus ends dock mode: the guest still has the keys", async () => {
  const { tab } = setup(mac);
  invoke.mockResolvedValue(false);
  menuRequest("guest-1");
  expect(tab("Bestie")).toHaveFocus();
  await waitFor(() => expect(numbers()).toEqual([]));
  invoke.mockRejectedValue(new Error("gone"));
  menuRequest("guest-1");
  await waitFor(() => expect(numbers()).toEqual([]));
});

it("a late refusal from an earlier entry leaves the current mode on", async () => {
  const { draft } = setup(mac);
  const reply = deferred<boolean>();
  invoke.mockReturnValueOnce(reply.promise);
  menuRequest("guest-1");
  // Esc, then ⌘D from inside the app: a new entry with no native call.
  press("Escape", { code: "Escape" });
  act(() => draft.focus());
  menuRequest(null);
  expect(numbers()).toHaveLength(3);
  await act(async () => reply.resolve(false));
  expect(numbers()).toHaveLength(3);
});
