import type { Context } from "@deepseek-ai/cordis";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { PanelView } from "../panels/PanelView";
import type { RegisteredPanel } from "../panels/service";
import { MediaReviewViewer } from "../messages/MediaReviewViewer";
import type { MessageLinkOrigin } from "../messages/MessageRow";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import type { ConversationExtensions } from "./contracts";
import { useConversationPresentation } from "./ConversationPresentation";

export type ConversationHostServices = Pick<
  Context,
  "panels" | "relay" | "navigation"
>;
export type ConversationInteractions = Required<
  Pick<ThreadPanelProps, "onOpenLink" | "canOpenLink" | "onOpenMediaReview">
>;
type ConversationHostProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName"
> & {
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
  threadId?: string | undefined;
  children(interactions: ConversationInteractions): ReactNode;
};

/** At most one modal surface: opening a panel or a media review replaces the other. */
type Overlay =
  | {
      panel: RegisteredPanel;
      target: string;
      /** The opening message's thread; replacements keep it, like Channels. */
      origin?: MessageLinkOrigin | undefined;
      media?: undefined;
    }
  | {
      media: Pick<
        ComponentProps<typeof MediaReviewViewer>,
        "messageId" | "attachment" | "initialTime" | "hasComments"
      >;
      panel?: undefined;
    };

export function ConversationHost({
  host,
  extensions,
  session,
  scope,
  channelId,
  channelName,
  threadId,
  children,
}: ConversationHostProps) {
  const presented = useConversationPresentation();
  const presentation = useRef(presented);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!presented) setOverlay(undefined);
  }, [presented]);
  const viewer = scope.slice(-64);
  const relayUrl = scope.slice(0, -65);
  const panels = useSyncExternalStore(
    host.panels.subscribe,
    host.panels.snapshot,
  );
  const [overlay, setOverlay] = useState<Overlay>();
  // A panel never outlives its contribution.
  if (overlay?.panel && !panels.includes(overlay.panel)) setOverlay(undefined);
  // Captured callbacks may run late: nothing acts after unmount, and a plugin
  // panel acts only while it is still the overlay on screen.
  const mounted = useRef(false);
  const shown = useRef(overlay);
  useLayoutEffect(() => {
    mounted.current = true;
    shown.current = overlay;
    presentation.current = presented;
    return () => {
      mounted.current = false;
    };
  }, [overlay, presented]);
  const active = () => {
    const connection = host.relay.snapshot();
    return (
      mounted.current &&
      presentation.current &&
      connection.status === "ready" &&
      connection.session === session &&
      connection.scope === scope
    );
  };
  const canOpen = (target: string) => !!host.panels.resolve(target);
  const open = (url: string, origin?: MessageLinkOrigin) => {
    if (!active()) return false;
    const target = buzzLinkTarget(url, { viewer, communityOrigin: relayUrl });
    if (target) {
      setOverlay(undefined);
      void host.navigation.open(target);
      return true;
    }
    const panel = host.panels.resolve(url);
    if (!panel) return false;
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOverlay({ panel, target: url, origin });
    return true;
  };
  return (
    <>
      {children({
        onOpenLink: open,
        canOpenLink: canOpen,
        onOpenMediaReview: (
          messageId,
          attachment,
          initialTime,
          hasComments = false,
        ) => {
          if (active()) {
            trigger.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            setOverlay({
              media: { messageId, attachment, initialTime, hasComments },
            });
          }
        },
      })}
      {presented && overlay?.panel && (
        <Dialog
          open
          title={overlay.panel.title}
          placement="right"
          height="stable"
          finalFocus={() =>
            trigger.current?.isConnected ? trigger.current : false
          }
          onOpenChange={(next) => {
            if (!next) setOverlay(undefined);
          }}
        >
          <PanelView
            panel={overlay.panel}
            target={overlay.target}
            close={() => {
              if (shown.current === overlay) setOverlay(undefined);
            }}
            channelContext={{
              scope,
              channelId,
              channelName,
              viewer,
              relayUrl,
              ...(threadId ? { threadId } : {}),
            }}
            context={{
              channelId,
              ...(overlay.origin && { rootId: overlay.origin.rootId }),
              canOpen,
              open: (target) =>
                shown.current === overlay &&
                host.panels.snapshot().includes(overlay.panel) &&
                open(target, overlay.origin),
            }}
          />
        </Dialog>
      )}
      {presented && overlay?.media && (
        <MediaReviewViewer
          {...overlay.media}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          extensions={extensions}
          onOpenLink={open}
          restoreFocus={trigger}
          close={() => setOverlay(undefined)}
        />
      )}
    </>
  );
}
