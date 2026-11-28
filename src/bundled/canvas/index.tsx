import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { CanvasPanel } from "./CanvasPanel";
import { createCanvasChannel } from "./store";
import { canvasTools } from "./tools";
import { createCanvasViews, type CanvasViews } from "./view";
import { mapView } from "./views/map";
import { browserView, webView } from "./views/page";
import { videoView } from "./views/video";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The layer under the canvas. Another plugin injects this to add a view
     * type; the canvas then holds, shares and describes it like its own. */
    canvasViews: CanvasViews;
  }
}

/** What a link or an agent opens to show a conversation's canvas. */
export const CANVAS_TARGET = "buzz-canvas:";

export const inject = ["panels", "relay", "agents", "browser"];
export const apply: PluginModule["apply"] = (ctx) => {
  const views = createCanvasViews();
  ctx.provide("canvasViews", views);
  views.register(browserView(ctx.browser));
  views.register(webView);
  views.register(mapView());
  views.register(videoView);

  function Live({
    session,
    viewer,
    channelId,
  }: {
    session: RelaySession;
    viewer: string;
    channelId: string;
  }) {
    const channel = useMemo(
      () =>
        createCanvasChannel({
          channelId,
          views,
          read: async (filters, signal) => {
            if (!session.snapshotRead)
              throw new Error("Connect to your community to use the canvas.");
            return session.snapshotRead(
              filters as Parameters<
                NonNullable<RelaySession["snapshotRead"]>
              >[0],
              signal ? { signal } : {},
            );
          },
          publish: async (template, signal) => {
            const writer = session.configArtifactWriter;
            if (!writer)
              throw new Error("This community can't save a canvas yet.");
            const event = await writer.sign(
              { ...template, created_at: Math.floor(Date.now() / 1000) },
              signal ?? session.lifetimeSignal,
            );
            await writer.publish(event, signal ?? session.lifetimeSignal);
            return event;
          },
          follow: (listener) => session.artifacts.follow([channelId], listener),
        }),
      [session, channelId],
    );
    useEffect(() => () => channel.dispose(), [channel]);
    const resolve = useIdentityNames(session.names);
    return (
      <CanvasPanel
        channel={channel}
        views={views}
        viewer={viewer}
        name={(pubkey) => resolve(pubkey, formatPublicKey(pubkey) ?? "Someone")}
      />
    );
  }

  function Panel({ channelContext, context }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const channelId = channelContext?.channelId ?? context?.channelId;
    if (
      !channelId ||
      state.status !== "ready" ||
      !state.viewer ||
      (channelContext && state.scope !== channelContext.scope)
    )
      return (
        <p role="status">
          The canvas is unavailable while the connection recovers.
        </p>
      );
    return (
      <Live
        key={`${state.scope}:${state.generation}:${channelId}`}
        session={state.session}
        viewer={state.viewer}
        channelId={channelId}
      />
    );
  }

  ctx.panels.register({
    id: "canvas",
    title: "Canvas",
    // Views hold live state (a page, a playing video), so it stays a tab.
    inline: false,
    keepOpen: true,
    channelPlacement: "tab",
    matches: (target) => target === CANVAS_TARGET,
    channelMenu: {
      label: "Share a view",
      eligible: (channel: ChannelSummary, session: RelaySession) =>
        !channel.cached &&
        !channel.archived &&
        !!channel.members?.includes(session.viewer ?? ""),
    },
    component: Panel,
  });

  for (const tool of canvasTools(views, (channelId, rootId) =>
    ctx.panels.requestOpen({
      target: CANVAS_TARGET,
      channelId,
      ...(rootId ? { rootId } : {}),
    }),
  ))
    ctx.agents.addTool(tool);
  ctx.agents.addInstructions({
    id: "canvas",
    text: "To show people a web page, map or video beside the conversation, open it on the canvas with canvas_open; call canvas_read first for the view types and their state.",
  });
};
