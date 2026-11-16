import { useSyncExternalStore } from "react";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import { useChannelRoster } from "../../features/relay/react";
import type { RelaySnapshot } from "../../features/relay/service";
import type { PluginModule } from "../../plugins/api";
import { ClipboardCheckIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import inlineStyles from "../../shared/InlineReference.module.css";
import { canHoldTasks } from "./places";
import { taskLinkId, taskRoute } from "./route";
import { TaskLink } from "./TaskLink";
import { TasksPage } from "./TasksPage";
import { TasksPanel } from "./TasksPanel";
import { addTaskTools } from "./tools";

export const inject = [
  "pages",
  "panels",
  "relay",
  "navigation",
  "agents",
  "conversation",
];

const scopeOf = (state: RelaySnapshot) =>
  state.viewer && state.scope
    ? {
        viewer: state.viewer,
        communityOrigin: state.scope.slice(0, -(state.viewer.length + 1)),
      }
    : undefined;

export const apply: PluginModule["apply"] = (ctx) => {
  let active = true;
  // Comments open panels and links the way any conversation does.
  const host = {
    panels: ctx.panels,
    relay: ctx.relay,
    navigation: ctx.navigation,
  };
  ctx.effect(() => () => {
    active = false;
  });

  ctx.pages.register({
    id: "tasks",
    title: "Tasks",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: { version: 1, validate: (params) => !!taskRoute(params) },
    component: (props) => (
      <TasksPage
        {...props}
        relay={ctx.relay}
        navigator={ctx.navigation}
        host={host}
      />
    ),
  });

  ctx.conversation.registerLink({
    id: "task",
    title: "Task links",
    matches: (url) => taskLinkId(url) !== null,
    className: inlineStyles.link,
    component: ({ url }) => <TaskLink url={url} relay={ctx.relay} />,
  });

  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const { channels } = useChannelRoster(state.session.channels);
    const channel =
      state.scope === context.scope
        ? channels.find((item) => item.id === context.channelId)
        : undefined;
    // No task can live in a DM or a huddle, so their panel could only be
    // empty. An archived place keeps it: its tasks are still there to read.
    if (
      channel &&
      !channel.pending &&
      !canHoldTasks({ type: channel.channelType, huddle: channel.huddle })
    )
      return null;
    return (
      <IconButton
        size="sm"
        variant="ghost"
        data-channel-panel-toggle=""
        icon={<ClipboardCheckIcon size={16} aria-hidden="true" />}
        aria-label="Toggle tasks"
        title="Tasks"
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          if (active && available()) toggle(context.channelId);
        }}
      />
    );
  }
  function Panel({ channelContext }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const scope = scopeOf(state);
    if (
      !channelContext ||
      !scope ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return (
        <p role="status">Connect to this conversation to see its tasks.</p>
      );
    return (
      <TasksPanel
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        session={state.session}
        chat={channelContext.channelId}
        comments={{ scope: state.scope, host }}
        openConversation={(channelId) =>
          void ctx.navigation.open({
            version: 1,
            kind: "conversation",
            scope,
            channelId,
          })
        }
      />
    );
  }
  ctx.panels.register({
    id: "tasks",
    title: "Tasks",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "side",
    component: Panel,
  });

  addTaskTools(ctx.agents);
};
