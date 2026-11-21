import { createRoot } from "react-dom/client";
import {
  CONVERSATION_SEARCH_ID,
  SEARCH_ID,
} from "../../app/shell/search-shortcuts";
import { isApplePlatform } from "../../features/shortcuts/format";
import type {
  BundledShortcuts,
  KeyBinding,
  Shortcut,
} from "../../features/shortcuts/service";
import type { PluginModule } from "../../plugins/api";
import { enableMenuLetters } from "../../shared/design-system/ui/menu-letters";
import { stepConversation } from "../channels/conversation-rows";
import {
  bottom,
  focusComposer,
  focusMessages,
  focusPane,
  halfPage,
  inSidebar,
  leave,
  openActions,
  revealConversation,
  sideways,
  step,
  top,
  typing,
  messageStops,
  stepPart,
} from "./motion";
import { createPending, SHOW_AFTER_MS } from "./pending";
import { LEADER, type Sequence, type SequenceGroup } from "./sequences";
import { WhichKey } from "./WhichKey";

export const inject = ["shortcuts", "navigation"];

/** Space selects these itself, so it stays theirs instead of the leader's. */
const SPACE_SELECTS =
  'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="menuitemcheckbox"], [role="menuitemradio"]';

export const apply: PluginModule["apply"] = (ctx) => {
  // A bundled plugin may run host shortcuts by id (BundledShortcuts).
  const shortcuts = ctx.shortcuts as BundledShortcuts;
  const navigation = ctx.navigation;
  const apple = isApplePlatform(globalThis.navigator?.platform ?? "");

  /** A polite live region, one per activation so a quick re-enable keeps it. */
  let status: HTMLElement | undefined;
  const announce = (text: string) => {
    const live = status;
    if (!live) return;
    live.textContent = "";
    requestAnimationFrame(() => {
      live.textContent = text;
    });
  };

  /** Focus is another bundled plugin's; run its shortcut if it is available. */
  const toggleFocus = () => {
    const toggle = shortcuts
      .snapshot()
      .find(
        (entry) => entry.pluginId === "buzz.focus" && entry.id === "toggle",
      );
    if (toggle && (!toggle.when || toggle.when())) void toggle.run();
    else announce("Turn on the Focus plugin to use this.");
  };
  const searchHere = () => {
    if (inSidebar() || !shortcuts.runHost(CONVERSATION_SEARCH_ID))
      shortcuts.runHost(SEARCH_ID);
  };

  const sequences: readonly Sequence[] = [
    { keys: "gg", title: "Top", run: top },
    {
      keys: "go",
      title: "Actions for the focused item",
      run: () => {
        if (!openActions())
          announce("No actions here. Move to a message or conversation first.");
      },
    },
    {
      keys: "]b",
      title: "Next conversation",
      run: () => stepConversation("next", false),
    },
    {
      keys: "[b",
      title: "Previous conversation",
      run: () => stepConversation("previous", false),
    },
    {
      keys: "]u",
      title: "Next unread conversation",
      run: () => stepConversation("next", true),
    },
    {
      keys: "[u",
      title: "Previous unread conversation",
      run: () => stepConversation("previous", true),
    },
    { keys: `${LEADER}/`, title: "Search where you are", run: searchHere },
    {
      keys: `${LEADER}${LEADER}`,
      title: "Switch conversation",
      run: () => shortcuts.runHost(SEARCH_ID),
    },
    {
      keys: `${LEADER}s/`,
      title: "Search Buzz",
      run: () => shortcuts.runHost(SEARCH_ID),
    },
    {
      keys: `${LEADER}sc`,
      title: "Search this conversation",
      run: () => shortcuts.runHost(CONVERSATION_SEARCH_ID),
    },
    {
      keys: `${LEADER}sk`,
      title: "Keyboard shortcuts",
      run: () =>
        void navigation.open({
          version: 1,
          kind: "settings",
          section: "shortcuts",
        }),
    },
    { keys: `${LEADER}tz`, title: "Focus", run: toggleFocus },
    {
      keys: `${LEADER},`,
      title: "Settings",
      run: () => void navigation.open({ version: 1, kind: "settings" }),
    },
    {
      keys: `${LEADER}h`,
      title: "Home",
      run: () => void navigation.open({ version: 1, kind: "home" }),
    },
  ];
  const groups: readonly SequenceGroup[] = [
    { keys: LEADER, title: "Leader" },
    { keys: `${LEADER}s`, title: "Search" },
    { keys: `${LEADER}t`, title: "Toggle" },
    { keys: "g", title: "Go" },
    { keys: "]", title: "Next" },
    { keys: "[", title: "Previous" },
  ];
  // Neovim's which-key shows the leader at once (delay 0); others after a pause.
  const pending = createPending(
    () => sequences,
    (typed) => (typed.startsWith(LEADER) ? 0 : SHOW_AFTER_MS),
  );

  ctx.effect(() => {
    const release = enableMenuLetters("hjkl");
    const host = document.createElement("div");
    const live = document.createElement("p");
    live.setAttribute("role", "status");
    live.className = "sr-only";
    status = live;
    document.body.append(host, live);
    const root = createRoot(host);
    root.render(
      <WhichKey
        pending={pending}
        sequences={() => sequences}
        groups={groups}
      />,
    );
    // Its own root: no host surface hosts a plugin's global menu. It renders
    // only the shared Menu, which needs no host provider.
    return () => {
      // Disabling can happen during a render; finish once it is done.
      queueMicrotask(() => {
        pending.cancel();
        release();
        root.unmount();
        host.remove();
        live.remove();
        if (status === live) status = undefined;
      });
    };
  });

  /** In an open menu, its own keys win; only j/k/h/l move there. */
  // Focus moves into a just-opened menu a frame later, so check the popup too.
  const inMenu = () =>
    !!document.activeElement?.closest('[role="menu"]') ||
    !!document.querySelector('[role="menu"][data-open]');
  let order = 0;
  const key = (
    id: string,
    title: string,
    binding: KeyBinding | readonly KeyBinding[],
    run: Shortcut["run"],
    { when, ...options }: Partial<Shortcut> = {},
    menus = false,
  ) =>
    ctx.shortcuts.register({
      id,
      title,
      binding,
      run,
      order: order++,
      ...options,
      when: () => (menus || !inMenu()) && (!when || when()),
    });
  // Movement also works in dialogs such as Settings; it never fires in a field.
  const moving = { allowInModal: true, repeat: true };
  // Control is Buzz's Mod key off macOS, where Mod+L and Mod+K are taken.
  const control = (letter: string): KeyBinding =>
    apple ? { key: letter, ctrl: true } : { key: letter, alt: true };

  key("down", "Move down", { key: "j" }, () => step(true), moving, true);
  key("up", "Move up", { key: "k" }, () => step(false), moving, true);
  key("left", "Move left", { key: "h" }, () => sideways(false), moving, true);
  key("right", "Move right", { key: "l" }, () => sideways(true), moving, true);
  key("bottom", "Go to bottom", { key: "g", shift: true }, bottom, {
    allowInModal: true,
  });
  key(
    "half-page-down",
    "Scroll half a page down",
    apple ? { key: "d", ctrl: true } : { key: "d", mod: true },
    () => halfPage(true),
    moving,
  );
  key(
    "half-page-up",
    "Scroll half a page up",
    apple ? { key: "u", ctrl: true } : { key: "u", mod: true },
    () => halfPage(false),
    moving,
  );
  key("pane-left", "Focus the pane to the left", control("h"), () =>
    focusPane(false),
  );
  key("pane-right", "Focus the pane to the right", control("l"), () =>
    focusPane(true),
  );
  key("pane-composer", "Focus the message box", control("j"), focusComposer);
  key("pane-messages", "Focus the messages", control("k"), focusMessages);
  key("insert", "Type a message", { key: "i" }, focusComposer);
  // Within a message: its author, links, files and reactions, then back.
  key(
    "next-part",
    "Next part of the message",
    { key: "Tab" },
    () => stepPart(true),
    { when: () => !!messageStops() },
  );
  key(
    "previous-part",
    "Previous part of the message",
    { key: "Tab", shift: true },
    () => stepPart(false),
    { when: () => !!messageStops() },
  );
  key(
    "leave",
    "Leave the field or control",
    apple ? [{ key: "Escape" }, { key: "[", ctrl: true }] : { key: "Escape" },
    leave,
    {
      allowInEditable: true,
      // Escape in a terminal belongs to its shell.
      when: () =>
        !!document.activeElement &&
        document.activeElement !== document.body &&
        !document.activeElement.closest(".xterm"),
    },
  );
  key("back", "Go back", { key: "h", shift: true }, () => navigation.back(), {
    allowInVisit: true,
  });
  key(
    "forward",
    "Go forward",
    { key: "l", shift: true },
    () => navigation.forward(),
    {
      allowInVisit: true,
    },
  );
  key("reveal", "Show this conversation in the sidebar", { key: "\\" }, () => {
    if (!revealConversation()) announce("The sidebar is hidden.");
  });
  key(
    "go",
    "Go: top (gg) or actions (go)",
    { key: "g" },
    () => pending.start("g"),
    { allowInModal: true },
  );
  key("next", "Next: conversation (]b) or unread (]u)", { key: "]" }, () =>
    pending.start("]"),
  );
  key(
    "previous",
    "Previous: conversation ([b) or unread ([u)",
    { key: "[" },
    () => pending.start("["),
  );
  key("leader", "Leader", { key: LEADER }, () => pending.start(LEADER), {
    when: () => !typing() && !document.activeElement?.matches(SPACE_SELECTS),
  });
};
