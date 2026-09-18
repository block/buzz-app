import { useLayoutEffect } from "react";
import { IconTerminal2 } from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { PluginModule } from "../../plugins/api";
import type { ChannelLauncherProps } from "../../features/panels/service";
import { nativeBridge } from "./bridge";
import { createSessions } from "./sessions";
import { TerminalPanel } from "./TerminalPanel";

export const inject = ["panels", "shortcuts", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  // No unusable launcher or reserved shortcut in a browser-only host.
  if (!nativeBridge.available) return;
  const sessions = createSessions(
    nativeBridge,
    async () => (await import("./renderer")).createScreen,
    ctx.relay.snapshot,
  );
  let binding: { toggle(): void; available(): boolean } | undefined;
  ctx.effect(() => () => {
    binding = undefined;
    return sessions.dispose();
  });
  ctx.shortcuts.register({
    id: "toggle",
    title: "Toggle channel terminal",
    binding: { key: "j", mod: true },
    allowInEditable: true,
    when: () => !!binding?.available(),
    run: () => binding?.toggle(),
  });
  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    const target = JSON.stringify(context);
    useLayoutEffect(() => {
      const current = { toggle: () => toggle(target), available };
      binding = current;
      return () => {
        if (binding === current) binding = undefined;
      };
    }, [toggle, target, available]);
    return (
      <IconButton
        size="toolbar"
        variant={pressed ? "tint" : "ghost"}
        icon={<IconTerminal2 size={16} aria-hidden="true" />}
        aria-label="Toggle channel terminal"
        title="Terminal (Cmd/Ctrl+J)"
        aria-pressed={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          toggle(target);
        }}
      />
    );
  }
  ctx.panels.register({
    id: "terminal",
    title: "Terminal",
    matches: () => false,
    channelLauncher: Launcher,
    component: (props) => <TerminalPanel {...props} sessions={sessions} />,
  });
};
