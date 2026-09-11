import { useLayoutEffect } from "react";
import { TerminalSquare } from "lucide-react";
import type { PluginModule } from "../../plugins/api";
import type { ChannelLauncherProps } from "../../features/panels/service";
import { nativeBridge } from "./bridge";
import { createSessions } from "./sessions";
import { TerminalPanel } from "./TerminalPanel";
import styles from "./Terminal.module.css";

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
      <button
        type="button"
        className={styles.launcher}
        aria-label="Toggle channel terminal"
        title="Terminal (Cmd/Ctrl+J)"
        aria-pressed={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          toggle(target);
        }}
      >
        <TerminalSquare size={19} aria-hidden="true" />
      </button>
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
