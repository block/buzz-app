import { useCallback } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArchiveIcon,
  SignOutIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import {
  lifecycleFocusFallback,
  type LifecycleNoun,
} from "./ChannelLifecycleDialog";
import { useLifecycleOffer, type LifecycleSession } from "./useLifecycleOffer";

/** Settings offers live-state actions; the sidebar owns confirmation. */
export function ChannelLifecycleActions({
  channel,
  session,
  choose,
  noun = "channel",
}: {
  channel: ChannelSummary;
  session: LifecycleSession;
  choose(action: ChannelLifecycleAction, trigger: HTMLElement): void;
  noun?: LifecycleNoun;
}) {
  const permissions = useLifecycleOffer(session, channel);
  // A refreshed or live role can retire the focused action. Ref cleanup runs
  // before its button detaches, while it still owns focus; keep focus in the
  // pane unless something else took it meanwhile.
  const retire = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      const document = node.ownerDocument;
      if (document.activeElement !== node) return;
      const fallback = lifecycleFocusFallback(node);
      queueMicrotask(() => {
        if (!node.isConnected && document.activeElement === document.body)
          fallback?.focus({ preventScroll: true });
      });
    };
  }, []);
  if (!session.channelLifecycle.available)
    return <p>Channel actions unavailable on this connection</p>;
  return (
    <>
      {permissions?.canLeave && (
        <Button
          ref={retire}
          onClick={(event) => choose("leave", event.currentTarget)}
        >
          <SignOutIcon size={16} aria-hidden="true" />
          Leave {noun}
        </Button>
      )}
      {(permissions?.canArchive || permissions?.canUnarchive) && (
        <Button
          ref={retire}
          onClick={(event) =>
            choose(
              permissions.canUnarchive ? "unarchive" : "archive",
              event.currentTarget,
            )
          }
        >
          <ArchiveIcon size={16} aria-hidden="true" />
          {permissions.canUnarchive ? "Unarchive" : "Archive"} {noun}
        </Button>
      )}
      {permissions?.canDelete && (
        <Button
          ref={retire}
          variant="destructive"
          onClick={(event) => choose("delete", event.currentTarget)}
        >
          <TrashIcon size={16} aria-hidden="true" />
          Delete {noun}
        </Button>
      )}
    </>
  );
}
