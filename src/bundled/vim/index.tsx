import type { KeyBinding, Shortcut } from "../../plugins/author";
import type { PluginModule } from "../../plugins/api";
import { enableMenuLetters } from "../../shared/design-system/ui/menu-letters";
import { stepConversation } from "../channels/conversation-rows";
import { captureKeys } from "./capture";
import { composerModes } from "./composer";
import { cursorRow, trackCursor } from "./cursor";
import { host } from "./host";
import { editField, inMenu, typing } from "./dom";
import {
  cancelMoves,
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
  threadRow,
  top,
} from "./motion";
import { createPending, SHOW_AFTER_MS } from "./pending";
import { LEADER, type Sequence, type SequenceGroup } from "./sequences";
import { mountWhichKey } from "./WhichKey";

export const inject = ["shortcuts", "navigation", "messages", "focus"];

/** A polite live region while the plugin is on; a quick re-enable keeps
 * the newest one. */
function announcer() {
  let region: HTMLElement | undefined;
  return {
    announce(text: string) {
      const live = region;
      if (!live) return;
      live.textContent = "";
      requestAnimationFrame(() => {
        live.textContent = text;
      });
    },
    mountAnnouncer() {
      const live = document.createElement("p");
      live.setAttribute("role", "status");
      live.className = "sr-only";
      document.body.append(live);
      region = live;
      return () => {
        live.remove();
        if (region === live) region = undefined;
      };
    },
  };
}

/** Space selects these itself, so it stays theirs instead of the leader's. */
const SPACE_SELECTS =
  'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="menuitemcheckbox"], [role="menuitemradio"]';

export const apply: PluginModule["apply"] = (ctx) => {
  const shortcuts = ctx.shortcuts;
  host.messages = ctx.messages;
  const navigation = ctx.navigation;
  const apple = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

  const { announce, mountAnnouncer } = announcer();

  /** Escape on a message still marks the conversation read, as without Vim keys. */
  const markRead = () => {
    const entry = shortcuts
      .snapshot()
      .find(
        (shortcut) =>
          shortcut.pluginId === "buzz.channels" && shortcut.id === "mark-read",
      );
    if (entry && (!entry.when || entry.when())) void entry.run();
  };
  /** The message box's mode keys, while the plugin is on. */
  let modes: ReturnType<typeof composerModes> | undefined;
  /** Run an item of Buzz's New menu. */
  const startNew = (id: string, label: string) => {
    if (!shortcuts.runHost(id)) announce(`${label} isn't available here.`);
  };
  const searchHere = () => {
    if (inSidebar() || !shortcuts.runHost("conversation-search"))
      shortcuts.runHost("global-search");
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
      keys: `${LEADER}i`,
      title: "Type a message",
      run: () => {
        focusComposer();
        modes?.insert();
      },
    },
    {
      keys: `${LEADER}nn`,
      title: "New chat",
      run: () => startNew("new-chat", "New chat"),
    },
    {
      keys: `${LEADER}nc`,
      title: "New channel",
      run: () => startNew("new-channel", "New channel"),
    },
    {
      keys: `${LEADER}nd`,
      title: "New DM",
      run: () => startNew("new-dm", "New DM"),
    },
    {
      keys: `${LEADER}nw`,
      title: "New workspace",
      run: () => startNew("new-workspace", "New workspace"),
    },
    {
      keys: `${LEADER}${LEADER}`,
      title: "Switch conversation",
      run: () => shortcuts.runHost("global-search"),
    },
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
    { keys: `${LEADER}n`, title: "New" },
    { keys: "g", title: "Go" },
    { keys: "]", title: "Next" },
    { keys: "[", title: "Previous" },
  ];
  // Neovim's which-key shows the leader at once (delay 0); others after a pause.
  const pending = createPending(sequences, (typed) =>
    typed.startsWith(LEADER) ? 0 : SHOW_AFTER_MS,
  );

  ctx.effect(() => {
    const ownModes = composerModes({
      apple,
      announce,
      leader: () => pending.start(LEADER),
    });
    modes = ownModes;
    const stops = [
      // g is kept for gg and G, which reach a menu's first and last item.
      enableMenuLetters("hjklg"),
      trackCursor(),
      // The cursor, not the message box, takes focus when a conversation opens.
      ctx.focus.preferMessagesOnOpen(cursorRow),
      ownModes.stop,
      // After the modes, so the message box sees its keys first.
      captureKeys({ pending, markRead }),
      mountWhichKey({ pending, sequences, groups }),
      mountAnnouncer(),
      // Moves still waiting on a frame stop with the plugin.
      cancelMoves,
    ];
    // Disabling can happen during a render; finish once it is done.
    return () =>
      queueMicrotask(() => {
        pending.cancel();
        editField();
        for (const stop of stops) stop();
        if (modes === ownModes) modes = undefined;
      });
  });

  // Every key also runs from a selected field, which is not typing; none
  // runs while typing, except Escape. Moves work in dialogs such as Settings.
  const moving = { allowInModal: true, repeat: true };
  // Control is Buzz's Mod key off macOS, where Mod+L and Mod+K are taken.
  const control = (letter: string): KeyBinding =>
    apple ? { key: letter, ctrl: true } : { key: letter, alt: true };
  const half = (letter: string): KeyBinding =>
    apple ? { key: letter, ctrl: true } : { key: letter, mod: true };
  type Key = Omit<Shortcut, "order"> & {
    /** Also in an open menu, where its own keys otherwise win. */
    inMenus?: boolean;
    /** Also while typing in a field. */
    whileTyping?: boolean;
  };
  const keys: Key[] = [
    {
      id: "down",
      title: "Move down",
      binding: { key: "j" },
      run: () => step(true),
      ...moving,
      inMenus: true,
    },
    {
      id: "up",
      title: "Move up",
      binding: { key: "k" },
      run: () => step(false),
      ...moving,
      inMenus: true,
    },
    {
      id: "left",
      title: "Move left",
      binding: { key: "h" },
      run: () => sideways(false),
      ...moving,
      inMenus: true,
    },
    {
      id: "right",
      title: "Move right",
      binding: { key: "l" },
      run: () => sideways(true),
      ...moving,
      inMenus: true,
    },
    {
      id: "bottom",
      title: "Go to bottom",
      binding: { key: "g", shift: true },
      run: bottom,
      allowInModal: true,
    },
    {
      id: "half-page-down",
      title: "Scroll half a page down",
      binding: half("d"),
      run: () => halfPage(true),
      ...moving,
    },
    {
      id: "half-page-up",
      title: "Scroll half a page up",
      binding: half("u"),
      run: () => halfPage(false),
      ...moving,
    },
    // In a dialog, its panes: Settings' section list, section and details.
    {
      id: "pane-left",
      title: "Focus the pane to the left",
      binding: control("h"),
      run: () => focusPane(false),
      allowInModal: true,
    },
    {
      id: "pane-right",
      title: "Focus the pane to the right",
      binding: control("l"),
      run: () => focusPane(true),
      allowInModal: true,
    },
    {
      id: "pane-composer",
      title: "Focus the message box",
      binding: control("j"),
      run: focusComposer,
    },
    {
      id: "pane-messages",
      title: "Focus the messages",
      binding: control("k"),
      run: focusMessages,
    },
    {
      id: "open-thread",
      title: "Open the selected message's thread",
      binding: { key: "Enter" },
      run: () => {
        const row = threadRow();
        if (row) host.messages.openThread(row);
      },
      when: () => !!threadRow(),
    },
    {
      id: "leave",
      title: "Leave the field or control",
      binding: apple
        ? [{ key: "Escape" }, { key: "[", ctrl: true }]
        : { key: "Escape" },
      run: leave,
      whileTyping: true,
      // Escape in a terminal belongs to its shell.
      when: () =>
        !!document.activeElement &&
        document.activeElement !== document.body &&
        !document.activeElement.closest(".xterm"),
    },
    {
      id: "back",
      title: "Go back",
      binding: { key: "h", shift: true },
      run: () => navigation.back(),
      allowInVisit: true,
    },
    {
      id: "forward",
      title: "Go forward",
      binding: { key: "l", shift: true },
      run: () => navigation.forward(),
      allowInVisit: true,
    },
    {
      id: "reveal",
      title: "Show this conversation in the sidebar",
      binding: { key: "\\" },
      run: () => {
        if (!revealConversation()) announce("The sidebar is hidden.");
      },
    },
    {
      id: "go",
      title: "Go: top (gg) or actions (go)",
      binding: { key: "g" },
      run: () => pending.start("g"),
      allowInModal: true,
    },
    {
      id: "next",
      title: "Next: conversation (]b) or unread (]u)",
      binding: { key: "]" },
      run: () => pending.start("]"),
    },
    {
      id: "previous",
      title: "Previous: conversation ([b) or unread ([u)",
      binding: { key: "[" },
      run: () => pending.start("["),
    },
    {
      id: "leader",
      title: "Leader",
      binding: { key: LEADER },
      run: () => pending.start(LEADER),
      when: () => !document.activeElement?.matches(SPACE_SELECTS),
    },
  ];
  for (const [order, { when, inMenus, whileTyping, ...key }] of keys.entries())
    ctx.shortcuts.register({
      ...key,
      order,
      allowInEditable: true,
      when: () =>
        (inMenus || !inMenu()) &&
        (whileTyping || !typing()) &&
        (!when || when()),
    });
};
