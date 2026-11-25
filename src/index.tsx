import {
  createElement,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { CanvasPanel, createRoaming, type Roaming } from "./CanvasPanel";
import type {
  LauncherProps,
  PanelProps,
  PluginContext,
  Session,
} from "./host";
import { CanvasIcon, IconButton, useHostUi } from "./kit";
import { useHost } from "./react";
import { createCanvasChannel, type CanvasChannel } from "./store";
import { css } from "./styles";
import { canvasTools } from "./tools";
import { createCanvasViews } from "./view";
import { mapView } from "./views/map";
import { browserView, webView } from "./views/page";
import { videoView } from "./views/video";

/** What a link or an agent opens to show a conversation's canvas, followed by
 * a view's id for that view's own tab. */
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

  // Each view is a tab of its own, so one canvas is shared by several panels.
  type Room = { channel: CanvasChannel; roaming: Roaming; users: number };
  const rooms = new Map<string, Room>();
  // Named by the view the tab shows, where the host lets a panel name its tab.
  const useTabTitle = ctx.panels.useTabTitle;
  const TabTitle =
    useTabTitle &&
    (({ label }: { label: string }) => {
      useTabTitle(label);
      return null;
    });

  function Live({
    room: key,
    session,
    viewer,
    channelId,
    view,
    close,
  }: {
    room: string;
    session: Session;
    viewer: string;
    channelId: string;
    view: string | undefined;
    close(): void;
  }) {
    const room = useMemo(() => {
      const open = rooms.get(key);
      if (open) return open;
      const made: Room = {
        users: 0,
        roaming: createRoaming(),
        channel: createCanvasChannel({
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
      };
      rooms.set(key, made);
      return made;
    }, [key, session, channelId]);
    useEffect(() => {
      room.users += 1;
      return () => {
        room.users -= 1;
        // Another tab of this canvas may be about to take its place.
        setTimeout(() => {
          if (room.users || rooms.get(key) !== room) return;
          rooms.delete(key);
          room.channel.dispose();
        });
      };
    }, [room, key]);
    // Re-render when a name arrives.
    useSyncExternalStore(
      session.names?.subscribe ?? still,
      () => session.names?.snapshot() ?? 0,
    );
    return (
      <CanvasPanel
        channel={room.channel}
        roaming={room.roaming}
        views={views}
        viewer={viewer}
        id={view}
        open={(next) =>
          void ctx.panels.requestOpen({
            target: CANVAS_TARGET + (next ?? ""),
            channelId,
          })
        }
        close={close}
        TabTitle={TabTitle}
        name={(pubkey) => {
          const short = `${pubkey.slice(0, 8)}…`;
          return session.names?.resolve(pubkey, short) ?? short;
        }}
      />
    );
  }

  function Panel({ channelContext, context, target, close }: PanelProps) {
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
        room={`${state.scope}:${state.generation}:${channelId}`}
        session={state.session}
        viewer={state.viewer}
        channelId={channelId}
        // A tab opened from the channel's menu has the channel as its target.
        view={
          (target?.startsWith(CANVAS_TARGET) &&
            target.slice(CANVAS_TARGET.length)) ||
          undefined
        }
        close={close ?? still}
      />
    );
  }

  // A Solo chat has no channel menu, so the canvas gets a button in its
  // header instead. Channels keep the menu, and their header as it is.
  function Launcher({ context, pressed, toggle }: LauncherProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const solo = state.session?.channels
      ?.list()
      .channels.some(
        (channel) =>
          channel.id === context.channelId && channel.channelType === "solo",
      );
    if (!solo) return null;
    return (
      <IconButton
        label="Toggle canvas"
        title="Canvas"
        expanded={pressed}
        onClick={() => toggle(CANVAS_TARGET)}
      >
        <CanvasIcon />
      </IconButton>
    );
  }

  ctx.panels.register({
    id: "canvas",
    title: "Canvas",
    // Views hold live state (a page, a playing video), so it stays a tab.
    inline: false,
    keepOpen: true,
    channelPlacement: "tab",
    matches: (target: string) =>
      /^[a-z0-9._-]{0,64}$/.test(
        target.startsWith(CANVAS_TARGET)
          ? target.slice(CANVAS_TARGET.length)
          : "/",
      ),
    channelMenu: {
      label: "Share a view",
      eligible: (
        channel: {
          cached?: boolean;
          archived?: boolean;
          members?: string[];
          channelType?: string;
        },
        session: Session,
      ) =>
        !channel.cached &&
        !channel.archived &&
        // A Solo chat is the viewer's own.
        (channel.channelType === "solo" ||
          !!channel.members?.includes(session.viewer ?? "")),
    },
    channelLauncher: Launcher,
    component: Panel,
  });

  for (const tool of canvasTools(views, (channelId, rootId, view) =>
    ctx.panels.requestOpen({
      target: CANVAS_TARGET + (view ?? ""),
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
