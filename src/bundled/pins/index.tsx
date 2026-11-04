import { useCallback, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { canPin, canUnpin } from "../../features/pins/protocol";
import {
  PinFilledIcon,
  PinIcon,
  PinnedOffIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { PinsPanel } from "./PinsPanel";
import { channelPins, pinsSupported } from "./store";
import styles from "./Pins.module.css";

export const inject = ["panels", "relay", "conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  const navigator = ctx.navigation;

  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    return (
      <IconButton
        size="sm"
        variant="ghost"
        data-channel-panel-toggle=""
        icon={<PinIcon size={16} aria-hidden="true" />}
        aria-label="Toggle pinned messages"
        title="Pinned messages"
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          if (active && available()) toggle(context.channelId);
        }}
      />
    );
  }
  function Panel({ channelContext, close }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const scope = channelContext && splitPartition(channelContext.scope);
    const openMessage = useCallback(
      async (messageId: string) => {
        if (!channelContext || !scope) return false;
        const result = await navigator.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId: channelContext.channelId,
          messageId,
        });
        return result.status !== "failed";
      },
      [channelContext, scope],
    );
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return <p role="status">Connect to this channel to view pins.</p>;
    return (
      <PinsPanel
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        session={state.session}
        context={channelContext}
        close={close}
        openMessage={openMessage}
      />
    );
  }
  ctx.panels.register({
    id: "pins",
    title: "Pinned messages",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "side",
    component: Panel,
  });

  ctx.conversation.registerMessageAction({
    id: "pin",
    title: "Pin to channel",
    placement: "menu",
    icon: () => <PinIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      pinsSupported(session) &&
      !message.threadRootId &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)) &&
      canPin(session.channels.get?.(message.channelId)?.viewerRole),
    component: PinMenuItem,
    marker: PinMarker,
  });
};

/** Pins or unpins in place; the label follows the channel's current pins. */
function PinMenuItem({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const store = channelPins(session, message.channelId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const notify = useToastNotification();
  const pin = state.byMessage.get(message.id);
  const role = session.channels.get?.(message.channelId)?.viewerRole;
  if (pin && !canUnpin(pin, session.viewer, role)) return null;
  const run = () => {
    try {
      if (pin) store.unpin(pin);
      else store.pin(message.id);
      notify(pin ? "Unpinned from channel" : "Pinned to channel", "success");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : pin
            ? "The message could not be unpinned."
            : "The message could not be pinned.",
        "error",
      );
    }
    close();
  };
  return (
    <MenuItem disabled={state.status === "loading" && !pin} onClick={run}>
      <MenuIcon>
        {pin ? (
          <PinnedOffIcon size={16} aria-hidden="true" />
        ) : (
          <PinIcon size={16} aria-hidden="true" />
        )}
      </MenuIcon>
      {pin ? "Unpin from channel" : "Pin to channel"}
    </MenuItem>
  );
}

function PinMarker({
  message,
  session,
}: {
  message: ChannelMessage;
  session: RelaySession;
}) {
  const store = channelPins(session, message.channelId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  if (!state.byMessage.has(message.id)) return null;
  return (
    <span
      className={styles.marker}
      title="Pinned"
      role="img"
      aria-label="Pinned"
    >
      <PinFilledIcon size={12} aria-hidden="true" />
    </span>
  );
}
