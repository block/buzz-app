import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  /** The shell asks for New (its shortcut); this opens New message. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** The sidebar's + : every conversation starts in New message. */
export function NewMenu(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <ReadyNewMenu
      {...props}
      key={connection.scope ?? "disconnected"}
      session={connection.session}
      available={connection.status === "ready" || !!connection.cached}
    />
  );
}

function ReadyNewMenu({
  relay,
  navigator,
  session,
  available,
  triggerContainer,
  open,
  onOpenChange,
}: Props & { session: RelaySession; available: boolean }) {
  const scope = splitPartition(session.scope);
  const enabled = available && !!scope;
  const start = () => {
    if (relay.snapshot().session !== session || !enabled || !scope) return;
    void navigator.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      scope,
      route: { version: 1, params: "new-message" },
    });
  };
  const latest = useRef(start);
  latest.current = start;
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(false);
    latest.current();
  }, [open, onOpenChange]);
  const button = (
    <IconButton
      disabled={!enabled}
      aria-label="New message"
      title="New message"
      shape="round"
      size="md"
      icon={<PlusIcon strokeWidth={2.5} size={18} />}
      onClick={start}
    />
  );
  return triggerContainer === undefined
    ? button
    : triggerContainer && createPortal(button, triggerContainer);
}
