import type { Context } from "@deepseek-ai/cordis";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ConversationDetailPane } from "./ConversationDetailPane";
import { createPortal } from "react-dom";
import { PanelCard } from "../panels/PanelCard";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { PanelView } from "../panels/PanelView";
import {
  panelOpening,
  type PanelOpening,
  type RegisteredPanel,
} from "../panels/service";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { useConversationPresentation } from "./ConversationPresentation";
import { ForwardMessageProvider } from "../messages/ForwardMessage";
import type { MediaReview } from "./Conversation";

export type ConversationHostServices = Pick<
  Context,
  "panels" | "relay" | "navigation"
>;
export type ConversationInteractions = Required<
  Pick<ThreadPanelProps, "onOpenLink" | "canOpenLink" | "onOpenMediaReview">
>;
export type ConversationHostInteractions = ConversationInteractions & {
  canOpenLink(target: string): boolean;
  /** Explicit channel launchers may open panels without a URL matcher. */
  openPanel(
    panel: RegisteredPanel,
    target: string,
    returnFocus?: HTMLElement | null,
  ): boolean;
};
/** A containing workspace owns contextual detail tabs; standalone readers retain their fallback. */
export const ConversationTabsContext = createContext<{
  openLink(channelId: string, url: string, rootId?: string): boolean;
  openPanel(entry: PanelOpening, returnFocus?: HTMLElement | null): boolean;
} | null>(null);

type ConversationHostProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName"
> & {
  host: ConversationHostServices;
  threadId?: string | undefined;
  children(
    interactions: ConversationHostInteractions,
    mediaReview: MediaReview | undefined,
  ): ReactNode;
};

/** At most one modal surface: opening a panel or a media review replaces the other. */
type Overlay =
  | (PanelOpening & { media?: undefined })
  | {
      media: Pick<
        MediaReview,
        | "messageId"
        | "attachment"
        | "initialTime"
        | "hasComments"
        | "initialAttachments"
      >;
      panel?: undefined;
    };

export function ConversationHost({
  host,
  session,
  scope,
  channelId,
  channelName,
  threadId,
  children,
}: ConversationHostProps) {
  const presented = useConversationPresentation();
  const detailPane = useContext(ConversationDetailPane);
  const tabs = useContext(ConversationTabsContext);
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
  const companion = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (presented && overlay?.panel && detailPane)
      return detailPane.show(overlay, () => {
        const connection = host.relay.snapshot();
        if (
          !mounted.current ||
          !presentation.current ||
          shown.current !== overlay ||
          connection.status !== "ready" ||
          connection.session !== session ||
          connection.scope !== scope ||
          !companion.current?.isConnected
        )
          return;
        const focused = document.activeElement;
        if (focused === trigger.current || focused === document.body)
          companion.current.focus({ preventScroll: true });
      });
  }, [presented, overlay, detailPane, host.relay, session, scope]);
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
  // Focus returns to what opened the first overlay, not to a replaced one.
  const enter = () => {
    if (!shown.current)
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
  };
  const canOpen = useCallback(
    (target: string) => !!host.panels.resolve(target),
    [host.panels],
  );
  /** Replacements stay in the opening message's thread, like Channels. */
  const open = (url: string, rootId?: string) => {
    if (!active()) return false;
    if (tabs?.openLink(channelId, url, rootId)) return true;
    const target = buzzLinkTarget(url, { viewer, communityOrigin: relayUrl });
    if (target) {
      setOverlay(undefined);
      void host.navigation.open(target);
      return true;
    }
    const next = panelOpening(host.panels, channelId, url, rootId);
    if (!next) return false;
    enter();
    setOverlay(next);
    return true;
  };
  const panelProps = overlay?.panel
    ? {
        panel: overlay.panel,
        target: overlay.target,
        channelContext: {
          scope,
          channelId,
          channelName,
          viewer,
          relayUrl,
          ...(threadId ? { threadId } : {}),
        },
        context: {
          channelId,
          ...(overlay.rootId && { rootId: overlay.rootId }),
          canOpen,
          open: (target: string) =>
            shown.current === overlay &&
            host.panels.snapshot().includes(overlay.panel) &&
            open(target, overlay.rootId),
        },
      }
    : undefined;
  return (
    <ForwardMessageProvider
      session={session}
      scope={scope}
      navigation={host.navigation}
    >
      {children(
        {
          openPanel: (panel, target, returnFocus) => {
            if (!active() || !host.panels.snapshot().includes(panel))
              return false;
            if (
              tabs?.openPanel(
                {
                  panel,
                  target,
                  channelId,
                  ...(threadId && { rootId: threadId }),
                },
                returnFocus,
              )
            )
              return true;
            enter();
            if (returnFocus) trigger.current = returnFocus;
            setOverlay({
              panel,
              target,
              channelId,
              ...(threadId && { rootId: threadId }),
            });
            return true;
          },
          onOpenLink: (url, origin) => open(url, origin?.rootId),
          canOpenLink: canOpen,
          onOpenMediaReview: (
            messageId,
            attachment,
            initialTime,
            hasComments = false,
            initialAttachments,
          ) => {
            if (active()) {
              enter();
              setOverlay({
                media: {
                  messageId,
                  attachment,
                  initialTime,
                  hasComments,
                  initialAttachments,
                },
              });
            }
          },
        },
        presented && overlay?.media
          ? {
              ...overlay.media,
              restoreFocus: trigger,
              close: () => setOverlay(undefined),
            }
          : undefined,
      )}
      {presented &&
        panelProps &&
        (detailPane ? (
          createPortal(
            <PanelCard
              ref={companion}
              {...panelProps}
              close={() => {
                if (shown.current !== overlay) return;
                setOverlay(undefined);
                trigger.current?.isConnected && trigger.current.focus();
              }}
            />,
            detailPane.container,
          )
        ) : (
          <Dialog
            open
            title={panelProps.panel.title}
            placement="bottom"
            backdrop="subtle"
            size="wide"
            closePlacement="start"
            height="stable"
            finalFocus={() =>
              trigger.current?.isConnected ? trigger.current : false
            }
            onOpenChange={(next) => {
              if (!next) setOverlay(undefined);
            }}
          >
            <PanelView
              {...panelProps}
              close={() => {
                if (shown.current === overlay) setOverlay(undefined);
              }}
            />
          </Dialog>
        ))}
    </ForwardMessageProvider>
  );
}
