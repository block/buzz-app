import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useListedChannel } from "../../features/relay/listed-channel";
import type { PanelProps } from "../../features/panels/service";
import { FileTextIcon } from "../../shared/design-system/icons";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { CanvasEditor } from "./CanvasEditor";

function eligible(channel: ChannelSummary, session: RelaySession) {
  return (
    !channel.cached &&
    (!channel.readOnly || channel.viewerRole === "guest") &&
    !!channel.members?.includes(session.viewer ?? "")
  );
}

export function registerCanvas(ctx: Context) {
  function Panel({ channelContext }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const readOnly = useListedChannel(
      state.status === "ready" ? state.session.channels : undefined,
      channelContext?.channelId,
      (channel) =>
        !channel ||
        !!channel.archived ||
        !!channel.readOnly ||
        !!channel.cached,
    );
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return (
        <p role="status">
          Canvas is unavailable while the connection recovers.
        </p>
      );
    return (
      <CanvasEditor
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        readOnly={readOnly}
        canvas={state.session.canvas}
        profiles={state.session.profiles}
        scope={state.scope}
        channelId={channelContext.channelId}
      />
    );
  }
  ctx.panels.register({
    id: "canvas",
    restore: "view",
    title: "Canvas",
    icon: FileTextIcon,
    matches: () => false,
    channelMenu: { label: "View canvas", eligible },
    component: Panel,
  });
}
