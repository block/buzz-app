import { useCallback, useEffect, useLayoutEffect } from "react";
import { TerminalWindowIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { PluginModule } from "../../plugins/api";
import type { ChannelLauncherProps } from "../../features/panels/service";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import { nativeBridge } from "./bridge";
import { createSessions } from "./sessions";
import { TerminalPanel } from "./TerminalPanel";
import { createTerminalFontPreference } from "./font-preference";
import {
  createTerminalPlacementPreference,
  type TerminalPlacement,
} from "./placement-preference";
import {
  createTerminalSettingsDraft,
  TerminalSettings,
} from "./TerminalSettings";

export const inject = ["panels", "shortcuts", "relay", "settingsCards"];
const TOGGLE_BINDING = { key: "j", mod: true } as const;
export const apply: PluginModule["apply"] = (ctx) => {
  // No unusable launcher or reserved shortcut in a browser-only host.
  if (!nativeBridge.available) return;
  const font = createTerminalFontPreference();
  const placement = createTerminalPlacementPreference();
  const drafts = createTerminalSettingsDraft();
  const sessions = createSessions(
    nativeBridge,
    async () => {
      const { createScreen } = await import("./renderer");
      return (input, resize) => createScreen(input, resize, font);
    },
    ctx.relay.snapshot,
  );
  let binding:
    | {
        toggle(): void;
        available(): boolean;
        target: string;
        pressed: boolean;
      }
    | undefined;
  let reopen: string | undefined;
  let focusRequest: string | undefined;
  let registration = 0;
  ctx.effect(() => () => {
    binding = undefined;
    reopen = undefined;
    focusRequest = undefined;
    font.dispose();
    placement.dispose();
    return sessions.dispose();
  });
  ctx.settingsCards.register({
    id: "settings",
    title: "Terminal",
    icon: TerminalWindowIcon,
    group: "Plugins",
    component: (props) => (
      <TerminalSettings
        {...props}
        font={font}
        placement={placement}
        drafts={drafts}
      />
    ),
  });
  ctx.shortcuts.register({
    id: "toggle",
    title: "Toggle channel terminal",
    binding: TOGGLE_BINDING,
    // Plugin Settings order: the terminal action is the category's primary action.
    order: 10,
    allowInEditable: true,
    when: () => !!binding?.available(),
    run: () => binding?.toggle(),
  });
  function Launcher({
    context,
    toggle,
    pressed,
    available,
    revision,
  }: ChannelLauncherProps & { revision: number }) {
    const target = JSON.stringify(context);
    const toggleWithFocus = useCallback(() => {
      focusRequest = pressed ? undefined : target;
      toggle(target);
    }, [pressed, target, toggle]);
    useLayoutEffect(
      () => () => {
        if (focusRequest === target) focusRequest = undefined;
      },
      [target],
    );
    useLayoutEffect(() => {
      const current = {
        toggle: toggleWithFocus,
        available,
        target,
        pressed,
      };
      binding = current;
      return () => {
        if (binding === current) binding = undefined;
      };
    }, [toggleWithFocus, target, available, pressed]);
    useEffect(() => {
      const current = binding;
      // Let the host retire the old opening before opening the new contribution.
      queueMicrotask(() => {
        if (revision !== registration || binding !== current || !available())
          return;
        if (reopen === undefined) return;
        const requested = reopen;
        reopen = undefined;
        if (requested === target && !pressed) toggle(target);
      });
    }, [target, toggle, available, pressed, revision]);
    return (
      <IconButton
        size="toolbar"
        icon={<TerminalWindowIcon size={16} aria-hidden="true" />}
        aria-label="Toggle channel terminal"
        title={`Terminal (${formatBinding(TOGGLE_BINDING, isApplePlatform(navigator.platform)).text})`}
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          toggleWithFocus();
        }}
      />
    );
  }
  const requestFocus = (context: ChannelLauncherProps["context"]) => {
    if (binding?.target === JSON.stringify(context))
      focusRequest = binding.target;
  };
  const focusRequested = (context: ChannelLauncherProps["context"]) => {
    if (focusRequest !== JSON.stringify(context)) return false;
    focusRequest = undefined;
    return true;
  };
  const registerPanel = (value: TerminalPlacement) => {
    const revision = ++registration;
    return ctx.inject(["panels"], (scope) => {
      scope.panels.register({
        id: "terminal",
        title: "Terminal",
        matches: () => false,
        channelPlacement: value,
        channelLauncher: (props) => <Launcher {...props} revision={revision} />,
        component: (props) => (
          <TerminalPanel
            {...props}
            sessions={sessions}
            placement={value}
            focusRequested={focusRequested}
            requestFocus={requestFocus}
          />
        ),
      });
    });
  };
  let current = placement.snapshot().placement;
  let panel = registerPanel(current);
  ctx.effect(() =>
    placement.subscribe(() => {
      const next = placement.snapshot().placement;
      if (next === current) return;
      if (binding?.pressed) reopen = binding.target;
      current = next;
      panel.dispose();
      panel = registerPanel(next);
    }),
  );
};
