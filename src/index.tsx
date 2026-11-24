import {
  createElement,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { CanvasPanel } from "./CanvasPanel";
import type { PanelProps, PluginContext, Session } from "./host";
import { useHostUi } from "./kit";
import { useHost } from "./react";
import { createCanvasChannel } from "./store";
import { css } from "./styles";
import { canvasTools } from "./tools";
import { createCanvasViews } from "./view";
import { mapView } from "./views/map";
import { browserView, webView } from "./views/page";
import { videoView } from "./views/video";

/** What a link or an agent opens to show a conversation's canvas. */
const CANVAS_TARGET = "buzz-canvas:";
const still = () => () => {};

export const inject = ["react", "panels", "relay", "agents", "browser"];
export function apply(ctx: PluginContext) {
  useHost(ctx.react);
  // Optional on older hosts; the kit falls back to plain elements.
  useHostUi(ctx.reflect.get("ui") as Parameters<typeof useHostUi>[0]);
  // A plugin is one file, so its styles travel in it. Every class is prefixed.
  ctx.effect(() => {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.append(sheet);
    return () => sheet.remove();
  });

  const views = createCanvasViews();
  // The layer under the canvas: another plugin injects this to add a view type.
  ctx.provide?.("canvasViews", views);
  // Shows pages natively on macOS; elsewhere a page falls back to a frame.
  views.register(browserView(ctx.browser));
  views.register(webView);
  views.register(mapView());
  views.register(videoView);

  function Live({
    session,
    viewer,
    channelId,
  }: {
    session: Session;
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
            return session.snapshotRead(filters, signal ? { signal } : {});
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
    // Re-render when a name arrives.
    useSyncExternalStore(
      session.names?.subscribe ?? still,
      () => session.names?.snapshot() ?? 0,
    );
    return (
      <CanvasPanel
        channel={channel}
        views={views}
        viewer={viewer}
        name={(pubkey) => {
          const short = `${pubkey.slice(0, 8)}…`;
          return session.names?.resolve(pubkey, short) ?? short;
        }}
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
    matches: (target: string) => target === CANVAS_TARGET,
    channelMenu: {
      label: "Share a view",
      eligible: (
        channel: { cached?: boolean; archived?: boolean; members?: string[] },
        session: Session,
      ) =>
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
}
