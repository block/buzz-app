import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import { FileTextIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { CanvasEditor } from "../channels/CanvasEditor";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    return (
      <IconButton
        size="sm"
        variant={pressed ? "tint" : "ghost"}
        icon={<FileTextIcon size={16} aria-hidden="true" />}
        aria-label="Toggle channel canvas"
        title="Canvas"
        aria-pressed={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          if (active && available()) toggle(context.channelId);
        }}
      />
    );
  }
  function Panel({ channelContext }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return <p role="status">Connect to this channel to view canvas.</p>;
    return (
      <CanvasEditor
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        canvas={state.session.canvas}
        profiles={state.session.profiles}
        scope={state.scope}
        channelId={channelContext.channelId}
      />
    );
  }
  ctx.panels.register({
    id: "canvas",
    title: "Canvas",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "side",
    component: Panel,
  });
};
