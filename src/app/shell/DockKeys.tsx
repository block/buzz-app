import { invoke, isTauri } from "@tauri-apps/api/core";
import { useContext, useEffect, useRef, useState } from "react";
import { inTerminal } from "../../bundled/channels/conversation-rows";
import type { Communities } from "../../features/communities/service";
import type {
  Navigation,
  NavigationOpenOptions,
  OpenAttempt,
  OpenResult,
} from "../../features/navigation/controller";
import { sameOpen } from "../../features/navigation/controller";
import type { RegisteredPage } from "../../features/pages/service";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import { useResolvedBindings } from "../../features/shortcuts/useResolvedBindings";
import { isApplePlatform } from "../../features/shortcuts/format";
import { focusWithKeyboard } from "../../shared/design-system/useKeyboardFocusVisibility";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import {
  BESTIE_PAGE,
  BestieConversationContext,
  bestieFocusRequests,
} from "./bestie-context";
import {
  GO_TO_DOCK,
  GO_TO_DOCK_BINDING,
  GO_TO_DOCK_EVENT,
  nativeDockMenu,
} from "./dock-shortcut";
import type { SearchServices } from "./PageSearch";

/** The visually hidden instructions every dock tab names while dock mode is on. */
export const DOCK_HINT_ID = "shell-dock-keys-hint";
export const DOCK_HINT =
  "Press 1 to 9 to open an app, Return to open, Escape to go back.";
/** How long a press may wait for its open before focus is left alone. */
const PRESS_LIFETIME_MS = 1000;

export type DockKeyState = Readonly<{
  active: boolean;
  /** The tab dock mode starts on, which a second ⌘D opens. */
  entry: string | undefined;
  /** The effective Go to Dock chord, when one is registered and bound. */
  chord: KeyBinding | undefined;
  apple: boolean;
}>;

type SelectPage = (
  key: string,
  options?: Pick<NavigationOpenOptions, "focus" | "onAttempt">,
  // biome-ignore lint/suspicious/noConfusingVoidType: Selectors that ignore the open result stay valid.
) => Promise<OpenResult> | void;

type ReturnTo =
  | { kind: "guest"; id: string }
  | { kind: "element"; element: Element | null };

const panelId = (key: string) => `shell-page-${key}`;
const dockList = () =>
  document.querySelector<HTMLElement>('.shell-dock-pages [role="tablist"]');
const unavailable = (element: Element) =>
  !element.isConnected ||
  !!element.closest("[hidden], [inert]") ||
  !element.getClientRects().length;

/** The press-time viewer, community and relay session still apply. */
function pressScope(communities: Communities) {
  const pressed = communities.snapshot();
  const session = communities.relay.snapshot().session;
  return () => {
    const now = communities.snapshot();
    return (
      now.viewer === pressed.viewer &&
      now.selected === pressed.selected &&
      communities.relay.snapshot().session === session
    );
  };
}

/**
 * Armed at the press: a click, another key, or focus moving anywhere but the
 * opened page means the person has moved on, so the open leaves focus alone.
 * After its lifetime it reads as cancelled too.
 */
function armCancellation(expected: (target: Element) => boolean) {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const key = (event: KeyboardEvent) => {
    if (
      event.repeat ||
      ["Meta", "Shift", "Control", "Alt", "AltGraph"].includes(event.key)
    )
      return;
    cancel();
  };
  const focus = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || !expected(event.target)) cancel();
  };
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("keydown", key, true);
  document.addEventListener("focusin", focus, true);
  const dispose = () => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", focus, true);
  };
  const timer = setTimeout(() => {
    cancel();
    dispose();
  }, PRESS_LIFETIME_MS);
  return { cancelled: () => cancelled, dispose };
}

/**
 * ⌘D ("Go to Dock") moves keyboard focus to the app dock with Bestie
 * selected and numbers every app. Then ⌘D again or Return opens the focused
 * app, 1–9 opens the nth, and Escape goes back to where focus was. Opening
 * moves focus into the app; Bestie puts the cursor in its composer.
 */
export function useDockKeys({
  shortcuts,
  bindings,
  communities,
  navigation,
  pages,
  onSelect,
  desktop = isTauri(),
  platform = navigator.platform,
}: {
  shortcuts: SearchServices["shortcuts"] | undefined;
  bindings: SearchServices["shortcutBindings"] | undefined;
  communities: Communities;
  navigation: Pick<Navigation, "snapshot"> | undefined;
  /** The dock's live order; digits read it at the press. */
  pages: readonly RegisteredPage[];
  onSelect: SelectPage;
  desktop?: boolean;
  platform?: string;
}): DockKeyState {
  const apple = isApplePlatform(platform);
  const native = nativeDockMenu(desktop, platform);
  const [active, setActive] = useState(false);
  const mode = useRef<{ returnTo: ReturnTo; inScope: () => boolean }>(
    undefined,
  );
  // Each entry and exit moves this on: a late native refusal falls back only
  // for the latest exit.
  const exits = useRef(0);
  const latest = useRef({ pages, onSelect, navigation });
  latest.current = { pages, onSelect, navigation };
  const entry = pages.some((page) => page.key === BESTIE_PAGE)
    ? BESTIE_PAGE
    : pages[0]?.key;
  const chord = useGoToDockChord(shortcuts, bindings);

  const actions = useRef<{
    enter(guest: string | null): void;
    open(key: string): void;
    leave(): void;
    end(): void;
  }>(undefined);
  actions.current = {
    end() {
      if (!mode.current) return;
      mode.current = undefined;
      exits.current += 1;
      setActive(false);
    },
    enter(guest) {
      const list = dockList();
      const tabs = list
        ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')]
        : [];
      const bestie = document.getElementById(`${panelId(BESTIE_PAGE)}-tab`);
      const target = bestie && list?.contains(bestie) ? bestie : tabs[0];
      if (!target) return;
      exits.current += 1;
      const entered = exits.current;
      mode.current = {
        returnTo: guest
          ? { kind: "guest", id: guest }
          : { kind: "element", element: document.activeElement },
        inScope: pressScope(communities),
      };
      setActive(true);
      focusWithKeyboard(target);
      // A guest page holds native keyboard focus; only then does the main
      // view need it back, and only after the tab has DOM focus. If it stays
      // with the guest, the dock's keys would never arrive, so the mode ends.
      if (guest && native) {
        const refused = () => {
          if (exits.current === entered) actions.current?.end();
        };
        void invoke<boolean>("focus_main_view").then((focused) => {
          if (!focused) refused();
        }, refused);
      }
    },
    open(key) {
      if (!mode.current) return;
      actions.current?.end();
      const { onSelect, navigation } = latest.current;
      const inScope = pressScope(communities);
      if (key === BESTIE_PAGE) {
        const conversation = bestieConversation.current;
        const press = armCancellation(
          (target) =>
            target.matches("textarea") &&
            !!document.getElementById(panelId(BESTIE_PAGE))?.contains(target),
        );
        const expires = performance.now() + PRESS_LIFETIME_MS;
        const result = onSelect(BESTIE_PAGE, {
          focus: "preserve",
          onAttempt: ({ attempt, result }) => {
            void result.then((settled) => {
              if (
                !conversation ||
                !current(settled, attempt) ||
                !inScope() ||
                press.cancelled()
              ) {
                press.dispose();
                return;
              }
              // Cancellation stays armed until Bestie consumes or drops it.
              const request = {
                attempt,
                session: conversation.session,
                channelId: conversation.channelId,
                inScope,
                cancelled: press.cancelled,
                expires,
              };
              const stop = bestieFocusRequests.subscribe(() => {
                if (bestieFocusRequests.snapshot() === request) return;
                stop();
                press.dispose();
              });
              bestieFocusRequests.post(request);
            });
          },
        });
        if (!result) press.dispose();
        return;
      }
      const panel = () => document.getElementById(panelId(key));
      const press = armCancellation((target) => !!panel()?.contains(target));
      const result = onSelect(key, {
        focus: "content",
        onAttempt: ({ attempt, result }) => {
          void result.then((settled) => {
            const proceed =
              current(settled, attempt) && inScope() && !press.cancelled();
            press.dispose();
            const tabpanel = panel();
            if (
              !proceed ||
              tabpanel?.getAttribute("role") !== "tabpanel" ||
              tabpanel.closest("[hidden], [inert]")
            )
              return;
            // A page that took focus keeps it; otherwise its tabpanel does.
            const focused = document.activeElement;
            if (
              focused &&
              focused !== document.body &&
              !dockList()?.contains(focused)
            )
              return;
            focusWithKeyboard(tabpanel);
          });
        },
      });
      if (!result) press.dispose();
      function current(settled: OpenResult, attempt: OpenAttempt) {
        return (
          settled.status === "opened" &&
          sameOpen(navigation?.snapshot().attempt, attempt) &&
          !attempt.signal.aborted
        );
      }
    },
    leave() {
      const state = mode.current;
      if (!state) return;
      actions.current?.end();
      const exit = exits.current;
      const fallback = () => {
        const focused = document.activeElement;
        if (
          exit !== exits.current ||
          (focused &&
            focused !== document.body &&
            !dockList()?.contains(focused))
        )
          return;
        const main = document.getElementById("main-content");
        if (main) focusWithKeyboard(main);
      };
      const { returnTo, inScope } = state;
      if (returnTo.kind === "guest") {
        const host = [
          ...document.querySelectorAll("[data-browser-session]"),
        ].find(
          (element) =>
            element.getAttribute("data-browser-session") === returnTo.id,
        );
        if (!native || !host || unavailable(host) || !inScope()) {
          fallback();
          return;
        }
        void invoke<boolean>("browser_focus", { sessionId: returnTo.id }).then(
          (focused) => {
            if (!focused) fallback();
          },
          fallback,
        );
        return;
      }
      const element = returnTo.element;
      if (
        element instanceof HTMLElement &&
        element !== document.body &&
        element.isConnected &&
        !element.closest("[inert]") &&
        inScope()
      ) {
        element.focus({ preventScroll: true });
        if (document.activeElement === element) return;
      }
      fallback();
    },
  };

  // The shell's Bestie DM, read at the press for the composer handoff.
  const conversation = useContext(BestieConversationContext);
  const bestieConversation = useRef(conversation);
  bestieConversation.current = conversation;

  // One owner of ⌘D per platform: the native menu on macOS desktop, a web
  // shortcut elsewhere on desktop, nothing in browser builds.
  useEffect(() => {
    if (!shortcuts || !desktop) return;
    let guest: string | null = null;
    const remove = shortcuts.registerHost(
      {
        id: GO_TO_DOCK,
        title: "Go to dock",
        binding: GO_TO_DOCK_BINDING,
        order: HOST_SHORTCUT_ORDER.goToDock,
        allowInEditable: true,
        // Off Apple, Ctrl+D in a terminal is end of input.
        ...(native ? {} : { when: () => !inTerminal() }),
        run: () => {
          if (mode.current) {
            const focused = document.activeElement?.closest('[role="tab"]');
            const key = focused?.getAttribute("data-tab-value");
            if (key && dockList()?.contains(focused ?? null)) {
              actions.current?.open(key);
              return;
            }
            // Focus left the dock without a focusout, as WebKit does when the
            // focused tab is removed: start again from here.
            actions.current?.end();
          }
          actions.current?.enter(guest);
        },
      },
      // Ctrl+D is new in this version: off macOS, a shortcut someone already
      // saved on it keeps it, and Go to dock is unbound until given a key.
      { yields: true },
    );
    if (!native) return remove;
    const request = (event: Event) => {
      const detail = (event as CustomEvent<{ browserSessionId?: unknown }>)
        .detail;
      guest =
        typeof detail?.browserSessionId === "string"
          ? detail.browserSessionId
          : null;
      try {
        shortcuts.runHost(GO_TO_DOCK);
      } finally {
        guest = null;
      }
    };
    window.addEventListener(GO_TO_DOCK_EVENT, request);
    return () => {
      window.removeEventListener(GO_TO_DOCK_EVENT, request);
      remove();
    };
  }, [shortcuts, desktop, native]);

  // A key the dock used stays its own until it is released: its repeats, and
  // the release Space activates on, must not reach the tab or what opened.
  const held = useRef<string>(undefined);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== held.current) return;
      // A fresh press means the release went elsewhere, such as to a guest.
      if (!event.repeat) {
        held.current = undefined;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== held.current) return;
      held.current = undefined;
      event.preventDefault();
      event.stopPropagation();
    };
    const blur = () => {
      held.current = undefined;
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // While on: the app tablist takes digits, Return, Space and Escape before
  // its buttons do; anything modified goes on to the window dispatcher.
  useEffect(() => {
    if (!active) return;
    const list = dockList();
    if (!list) {
      actions.current?.end();
      return;
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph") ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const digit = /^Digit([1-9])$/.exec(event.code);
      const focused = (event.target as Element | null)
        ?.closest?.('[role="tab"]')
        ?.getAttribute("data-tab-value");
      const key = digit
        ? latest.current.pages[Number(digit[1]) - 1]?.key
        : event.key === "Enter" || event.key === " "
          ? focused
          : undefined;
      if (!digit && !key && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      held.current = event.code;
      if (event.key === "Escape") actions.current?.leave();
      else if (key) actions.current?.open(key);
    };
    const focusout = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !list.contains(next))
        actions.current?.end();
    };
    const pointer = () => actions.current?.end();
    // WebKit sends no focusout when the focused tab itself is removed, such
    // as by disabling its plugin, so a removal that takes focus ends it too.
    const removed = new MutationObserver(() => {
      if (!list.isConnected || !list.contains(document.activeElement))
        actions.current?.end();
    });
    removed.observe(list, { childList: true, subtree: true });
    list.addEventListener("keydown", keydown, true);
    list.addEventListener("focusout", focusout);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      removed.disconnect();
      list.removeEventListener("keydown", keydown, true);
      list.removeEventListener("focusout", focusout);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, [active]);

  return { active, entry, chord, apple };
}

/** The effective Go to Dock chord: rebinds off Apple, the menu's on macOS.
 * Unbound while a saved shortcut holds its default. */
function useGoToDockChord(
  shortcuts: SearchServices["shortcuts"] | undefined,
  bindings: SearchServices["shortcutBindings"] | undefined,
) {
  return useResolvedBindings(shortcuts, bindings)?.get(GO_TO_DOCK)
    ?.effective[0];
}
