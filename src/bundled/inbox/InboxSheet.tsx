import {
  ConversationListToggle,
  ConversationListVisibility,
} from "../../features/conversation/ConversationListToggle";
import { CollectionCreationAction } from "../../features/conversation/ConversationList";
import {
  createContext,
  type ReactNode,
  useContext,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConversationExtensions,
  PageTabOptions,
  PageTabsProps,
  PageTabTarget,
} from "../../features/conversation/contracts";
import {
  ConversationHost,
  type ConversationHostServices,
} from "../../features/conversation/ConversationHost";
import { useConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { NoConversationSelected } from "../../features/conversation/NoConversationSelected";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PlusIcon, XIcon } from "../../shared/design-system/icons";
import { PageTabs } from "../channels/PageTabs";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { NewMessage } from "../../features/direct-messages/NewMessage";
import { SoloDraft } from "../../features/solo/SoloDraft";
import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useChannelRoster } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { ConversationTab } from "../channels/ConversationTab";
import { ChannelMembersButton } from "../channels/ChannelMembersDialog";
import { useChannelLabels } from "../channels/useChannelLabels";
import { InboxSheetActions } from "./InboxSheetActions";
import type { ConversationTab as Tab } from "../channels/useChannelTabState";
import { inboxRouteTarget, routeOf, detailOf, composingOf } from "./route";
import type { OpenTarget } from "../../features/navigation/targets";
import type { PageNavigation } from "../../features/navigation/service";
import styles from "./Inbox.module.css";

const FeedbackMount = createContext<HTMLElement | null>(null);
export const useActivityFeedbackMount = () => useContext(FeedbackMount);

const activitySheetRoute = {
  target: (
    params: Parameters<typeof inboxRouteTarget>[0],
  ): Extract<OpenTarget, { kind: "page" }> => inboxRouteTarget(params),
  filters: routeOf,
  detail: detailOf,
  composing: composingOf,
};

const sameConversation = (a: PageTabTarget, b: PageTabTarget) =>
  a.channelId === b.channelId && a.threadId === b.threadId;

/** Opening, traversal, and retention use the same current channel evidence. */
const availableInSheet = (
  channel: ChannelSummary | undefined,
  viewer: string | undefined,
) =>
  channel &&
  !channel.archived &&
  (!channel.readOnly || channel.viewerRole === "guest") &&
  !channel.cached &&
  !channel.huddle &&
  !channel.metadataPending &&
  (channel.channelType !== "solo" || !!channel.members?.includes(viewer ?? ""));

type Opening = {
  target: PageTabTarget;
  request: number;
  options?: PageTabOptions | undefined;
  reply?: boolean | undefined;
};

/** Collections keep their list mounted beside the shared conversation reader. */
export function InboxSheet({
  id,
  session,
  scope,
  children,
  host,
  extensions,
  navigation,
  detail,
  draftKind,
  route = activitySheetRoute,
}: PageTabsProps & {
  navigation?: PageNavigation | undefined;
  /** Existing full conversation workspace for direct chat destinations. */
  detail?: ReactNode;
  draftKind?: "team" | "solo";
  route?: typeof activitySheetRoute;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
}) {
  const list = useChannelRoster(session.channels);
  const listVisibility = useContext(ConversationListVisibility);
  const controlledList = !!listVisibility;
  const reader = useRef<HTMLElement>(null);
  const notify = useToastNotification();
  const [composer, setComposer] = useState<HTMLDivElement | null>(null);
  const presented = useConversationPresentation();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [opening, setOpening] = useState<Opening>();
  const [shown, setShown] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const selected = shown || !!detail;
  const [feedbackMount, setFeedbackMount] = useState<HTMLDivElement | null>(
    null,
  );
  // Keep responsive presentation and reader activity in sync with available
  // workspace width, including sidebar changes and enlarged text.
  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => {
      if (!container.clientWidth) return;
      const feed = container.querySelector<HTMLElement>(`.${styles.sheetFeed}`);
      const panes = feed?.closest<HTMLElement>(`.${styles.collectionPanes}`);
      if (feed && panes)
        panes.style.setProperty(
          "--collection-list-width",
          `${feed.getBoundingClientRect().width}px`,
        );
      setNarrow(
        container.clientWidth <
          48 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const feed = container.querySelector<HTMLElement>(`.${styles.sheetFeed}`);
    if (feed) observer.observe(feed);
    return () => observer.disconnect();
  }, [container]);
  const trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!presented || shown || drafting || !trigger.current?.isConnected)
      return;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected &&
      !focused.closest("[hidden]") &&
      !(narrow && composer?.contains(focused))
    )
      return;
    trigger.current.focus({ preventScroll: true });
  }, [presented, shown, drafting, narrow, composer]);
  const current = useRef<Opening | undefined>(undefined);
  const live = useRef(false);
  const sequence = useRef(0);
  const visit = useRef(navigation);
  const appliedVisit = useRef<PageNavigation | undefined>(undefined);
  const localVisit = useRef<string | undefined>(undefined);
  const returnTarget = useRef<OpenTarget | undefined>(undefined);
  useLayoutEffect(() => {
    visit.current = navigation;
  });
  const navigationScope = useMemo(
    () => ({
      viewer: session.viewer ?? "",
      communityOrigin: scope.slice(0, -((session.viewer?.length ?? 0) + 1)),
    }),
    [session.viewer, scope],
  );
  useLayoutEffect(() => {
    live.current = presented;
    if (!presented) {
      appliedVisit.current = undefined;
      localVisit.current = undefined;
      current.current = undefined;
      setShown(false);
      setDrafting(false);
    }
    return () => {
      live.current = false;
    };
  }, [presented]);
  const hide = useCallback(() => {
    current.current = undefined;
    setShown(false);
    setDrafting(false);
  }, []);
  const retire = useCallback(
    (active: PageNavigation | undefined) => {
      const detail = route.detail(active?.target);
      const compose = route.composing(active?.target);
      if (!active || (!detail && !compose)) return;
      host.navigation.dismiss(
        (candidate) => {
          const next = route.detail(candidate);
          if (
            candidate.kind !== "page" ||
            (candidate.scope !== undefined &&
              (candidate.scope?.viewer !== session.viewer ||
                candidate.scope?.communityOrigin !==
                  navigationScope.communityOrigin))
          )
            return false;
          return compose
            ? route.composing(candidate)
            : !!detail && !!next && sameConversation(detail, next);
        },
        returnTarget.current ?? {
          ...route.target(route.filters(active.target) ?? {}),
          scope: navigationScope,
        },
      );
    },
    [host.navigation, session.viewer, navigationScope, route],
  );
  const dismiss = useCallback(() => {
    if (route.composing(visit.current?.target))
      composer?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    hide();
    retire(visit.current);
  }, [hide, retire, composer, route]);
  const open = useCallback(
    (target: PageTabTarget, options?: PageTabOptions, reply = false) => {
      const connection = host.relay.snapshot();
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === target.channelId);
      if (
        !live.current ||
        connection.status !== "ready" ||
        connection.session !== session ||
        !availableInSheet(channel, session.viewer)
      )
        return false;
      if (!current.current)
        trigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      const next = { target, options, reply, request: ++sequence.current };
      current.current = next;
      setOpening(next);
      setShown(true);
      setDrafting(false);
      if (visit.current) {
        localVisit.current = visit.current.entryId;
        void host.navigation.open(
          {
            ...route.target({
              ...(route.filters(visit.current.target) ?? {}),
              ...target,
            }),
            scope: navigationScope,
          },
          { focus: "preserve" },
        );
      }
      return true;
    },
    [host.relay, host.navigation, session, navigationScope, route],
  );
  // Traversal restores presentation with fresh authority; it never replays a send.
  useLayoutEffect(() => {
    if (!navigation || !presented || appliedVisit.current === navigation)
      return;
    if (route.composing(navigation.target)) {
      localVisit.current = undefined;
      appliedVisit.current = navigation;
      setShown(false);
      setDrafting(true);
      return;
    }
    setDrafting(false);
    const target = route.detail(navigation.target);
    if (!target) {
      localVisit.current = undefined;
      appliedVisit.current = navigation;
      returnTarget.current = navigation.target;
      current.current = undefined;
      setShown(false);
      return;
    }
    const channel = list.channels.find((item) => item.id === target.channelId);
    // Downloaded membership is pending evidence, not a completed access denial.
    // Leave the visit unapplied until the existing channel owner verifies it.
    if (channel?.cached || channel?.metadataPending) return;
    if (!availableInSheet(channel, session.viewer)) {
      if (list.status === "ready") dismiss();
      return;
    }
    appliedVisit.current = navigation;
    const prior = current.current;
    // The route acknowledges a local opening; it must not restart its reveal.
    // Traversal to another visit still creates a fresh request below.
    const acknowledged =
      localVisit.current !== undefined &&
      localVisit.current !== navigation.entryId;
    localVisit.current = undefined;
    if (
      acknowledged &&
      prior &&
      sameConversation(prior.target, target) &&
      prior.target.messageId === target.messageId
    ) {
      setShown(true);
      return;
    }
    const next = {
      target,
      request: ++sequence.current,
      ...(prior &&
      sameConversation(prior.target, target) &&
      prior.target.messageId === target.messageId
        ? { options: prior.options, reply: prior.reply }
        : {}),
    };
    current.current = next;
    setOpening(next);
    setShown(true);
  }, [
    navigation,
    route,
    presented,
    list.channels,
    list.status,
    session.viewer,
    dismiss,
  ]);
  const close = useCallback(
    (target: PageTabTarget) => {
      if (!current.current || !sameConversation(current.current.target, target))
        return false;
      dismiss();
      return true;
    },
    [dismiss],
  );
  const isOpen = useCallback(
    (target: PageTabTarget) =>
      shown && !!opening && sameConversation(opening.target, target),
    [shown, opening],
  );
  const target = opening?.target;
  const selectedChannel = list.channels.find(
    (item) => item.id === target?.channelId,
  );
  const labelRoster = useMemo(
    () => (selectedChannel ? [selectedChannel] : []),
    [selectedChannel],
  );
  const { channels } = useChannelLabels(
    labelRoster,
    session.profiles,
    session.names,
  );
  const channel =
    channels.find((item) => item.id === target?.channelId) ?? selectedChannel;
  const available = availableInSheet(channel, session.viewer);
  useLayoutEffect(() => {
    if (shown && !available) dismiss();
  }, [shown, available, dismiss]);
  const detailHost = useMemo<ConversationHostServices>(
    () => ({
      relay: host.relay,
      panels: host.panels,
      navigation: {
        ...host.navigation,
        open: (target, options) => {
          const closing = visit.current;
          hide();
          const pending = host.navigation.open(target, options);
          // An admitted handoff retires the sheet before a quick Back can
          // return to it, even while the destination is still loading.
          if (
            closing &&
            host.navigation.snapshot().entry.id !== closing.entryId
          ) {
            retire(closing);
            return pending;
          }
          return pending.then((result) => {
            if (result.status === "opened") retire(closing);
            return result;
          });
        },
      },
    }),
    [host.relay, host.panels, host.navigation, hide, retire],
  );
  const navigateConversation = (target: PageTabTarget) => {
    const viewer = session.viewer;
    if (!viewer) return;
    void detailHost.navigation.open({
      version: 1,
      kind: "conversation",
      scope: navigationScope,
      channelId: target.channelId,
      ...(target.messageId && { messageId: target.messageId }),
      ...(target.threadId && {
        threadRootId: target.threadId,
        context: "channel",
      }),
    });
  };
  const showConversation = (channelId: string, messageId?: string) => {
    const target = { channelId, ...(messageId && { messageId }) };
    if (!open(target)) navigateConversation(target);
  };
  const expandDraft = () => {
    if (!presented || drafting) return;
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    current.current = undefined;
    setShown(false);
    setDrafting(true);
    if (visit.current)
      void host.navigation.open(
        {
          ...route.target({
            ...(route.filters(visit.current.target) ?? {}),
            compose: "new",
          }),
          scope: navigationScope,
        },
        { focus: "preserve" },
      );
  };
  const tab: Tab | undefined =
    target &&
    opening &&
    (target.threadId
      ? {
          id: `thread:${target.channelId}:${target.threadId}`,
          kind: "thread",
          channelId: target.channelId,
          rootId: target.threadId,
          messageId: target.messageId ?? target.threadId,
          revealRequest: opening.request,
          ...(opening.reply && { replyRequest: opening.request }),
        }
      : {
          id: `conversation:${target.channelId}`,
          kind: "conversation",
          channelId: target.channelId,
          messageId: target.messageId,
          revealRequest: opening.request,
          ...(!target.messageId && { focusRequest: opening.request }),
          ...(opening.options?.markRead === false && { markRead: false }),
        });
  return (
    <FeedbackMount value={shown ? feedbackMount : null}>
      <div
        ref={setContainer}
        className={styles.sheetHost}
        data-detail-workspace=""
        data-narrow={narrow || undefined}
      >
        <div
          className={styles.collectionPanes}
          data-detail-selected={selected || drafting || undefined}
          data-list-controlled={listVisibility ? "" : undefined}
          data-list-open={listVisibility?.open ?? true}
          data-list-animate={listVisibility?.animate ? "" : undefined}
        >
          <div className={styles.listTrack}>
            <ResizableSidebar
              scope={`${scope}:collection-list`}
              defaultWidth={352}
              className={styles.sheetFeed ?? ""}
              id={listVisibility?.controls}
              aria-hidden={listVisibility ? !listVisibility.open : undefined}
              inert={listVisibility ? !listVisibility.open : undefined}
            >
              <ConversationPresentation
                value={
                  presented &&
                  (listVisibility
                    ? listVisibility.open
                    : !narrow || (!selected && !drafting))
                }
              >
                <CollectionCreationAction
                  value={
                    <IconButton
                      variant="glass"
                      aria-label="New message"
                      title="New message"
                      onClick={expandDraft}
                      icon={<PlusIcon size={20} aria-hidden="true" />}
                    />
                  }
                >
                  {children(open, close, isOpen)}
                </CollectionCreationAction>
              </ConversationPresentation>
              {controlledList && (
                <div
                  className={`${styles.collectionCreate} ${styles.listDismiss}`}
                >
                  <ConversationListToggle inList />
                </div>
              )}
            </ResizableSidebar>
          </div>
          <section
            ref={reader}
            className={styles.collectionDetail}
            aria-label="Conversation detail"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !event.defaultPrevented &&
                (shown || drafting) &&
                event.currentTarget.contains(event.target as Node) &&
                !event.currentTarget.querySelector("[data-popup-open]")
              ) {
                event.preventDefault();
                event.stopPropagation();
                dismiss();
              }
            }}
          >
            {detail ?? (
              <PageTabs
                embedded
                closeReader={() => {
                  if (!shown && !drafting) return false;
                  dismiss();
                  return true;
                }}
                id={`${id}:reader`}
                label="Conversation"
                scope={scope}
                session={session}
                host={host}
                extensions={extensions}
              >
                {(openDetail) => (
                  <>
                    {!draftKind && !drafting && !shown ? (
                      <div className={styles.unselectedConversation}>
                        <NoConversationSelected />
                      </div>
                    ) : (
                      <div
                        ref={setComposer}
                        className={styles.draftContent}
                        hidden={shown}
                      >
                        {draftKind !== "solo" && (
                          <PanelHeader
                            variant="conversation"
                            title="New message"
                            navigation={
                              listVisibility ? (
                                <ConversationListToggle />
                              ) : (
                                narrow && (
                                  <IconButton
                                    size="sm"
                                    variant="glass"
                                    aria-label="Close new message"
                                    icon={<XIcon size={16} />}
                                    onClick={dismiss}
                                  />
                                )
                              )
                            }
                          />
                        )}
                        <ConversationPresentation
                          value={
                            presented &&
                            !shown &&
                            (!narrow ||
                              drafting ||
                              listVisibility?.open === false)
                          }
                        >
                          {draftKind === "solo" ? (
                            <SoloDraft
                              navigation={<ConversationListToggle />}
                              session={session}
                              scope={scope}
                              extensions={extensions}
                              onStarted={showConversation}
                              onFailed={(_id, message, retry) =>
                                notify(
                                  message,
                                  "error",
                                  retry
                                    ? {
                                        label: "Retry restoring message",
                                        onClick: () => {
                                          void retry();
                                        },
                                        timeout: Infinity,
                                      }
                                    : undefined,
                                )
                              }
                            />
                          ) : (
                            <NewMessage
                              layout={
                                draftKind === "team" ? "page" : "composer"
                              }
                              expanded
                              onAddressed={expandDraft}
                              allowChannels
                              session={session}
                              scope={scope}
                              channels={list.channels}
                              host={detailHost}
                              extensions={extensions}
                              onStarted={showConversation}
                              onOpenThread={(
                                channelId,
                                messageId,
                                threadId,
                              ) => {
                                openDetail(
                                  { channelId, messageId, threadId },
                                  { keep: true },
                                );
                              }}
                              onOpenChat={showConversation}
                              solo={
                                draftKind === "team"
                                  ? undefined
                                  : {
                                      onStarted: showConversation,
                                      onFailed: (_id, message, retry) =>
                                        notify(
                                          message,
                                          "error",
                                          retry
                                            ? {
                                                label:
                                                  "Retry restoring message",
                                                onClick: () => {
                                                  void retry();
                                                },
                                                timeout: Infinity,
                                              }
                                            : undefined,
                                        ),
                                    }
                              }
                            />
                          )}
                        </ConversationPresentation>
                      </div>
                    )}
                    {available && channel && target && tab && (
                      <div
                        className={styles.draftContent}
                        hidden={!shown}
                        data-conversation-reader=""
                      >
                        <ConversationPresentation value={presented && shown}>
                          <ConversationHost
                            key={tab.id}
                            host={detailHost}
                            session={session}
                            scope={scope}
                            channelId={channel.id}
                            channelName={channel.name}
                            threadId={target.threadId}
                          >
                            {(interactions) => (
                              <>
                                <PanelHeader
                                  variant="conversation"
                                  historyOverlay={!target.threadId}
                                  title={channel.name}
                                  icon={
                                    <ChannelMembersButton
                                      key={channel.id}
                                      session={session}
                                      channelId={channel.id}
                                      conversationName={channel.name}
                                      navigator={detailHost.navigation}
                                      onOpenConversation={(channelId) =>
                                        openDetail(
                                          { channelId },
                                          { keep: true },
                                        )
                                      }
                                      onOpenLink={(url) =>
                                        interactions.onOpenLink(url)
                                      }
                                      canOpenLink={interactions.canOpenLink}
                                    />
                                  }
                                  navigation={
                                    listVisibility ? (
                                      <ConversationListToggle />
                                    ) : (
                                      <IconButton
                                        size="sm"
                                        variant="glass"
                                        aria-label="Close conversation"
                                        title="Close conversation"
                                        icon={<XIcon size={16} />}
                                        onClick={dismiss}
                                      />
                                    )
                                  }
                                  actions={
                                    <InboxSheetActions
                                      key={tab.id}
                                      active={shown}
                                      panels={host.panels}
                                      context={{
                                        scope,
                                        channelId: channel.id,
                                        channelName: channel.name,
                                        viewer: session.viewer ?? "",
                                        relayUrl:
                                          navigationScope.communityOrigin
                                            .replace(/^https:/, "wss:")
                                            .replace(/^http:/, "ws:"),
                                        ...(target.threadId && {
                                          threadId: target.threadId,
                                        }),
                                      }}
                                      interactions={interactions}
                                      onOpen={() =>
                                        navigateConversation(target)
                                      }
                                    />
                                  }
                                />
                                <div ref={setFeedbackMount} />
                                <ConversationTab
                                  key={tab.id}
                                  tab={tab}
                                  active={shown}
                                  visit={false}
                                  channel={channel}
                                  session={session}
                                  scope={scope}
                                  extensions={extensions}
                                  openLink={interactions.onOpenLink}
                                  canOpenLink={interactions.canOpenLink}
                                  openThread={(messageId, rootId, intent) => {
                                    openDetail(
                                      {
                                        channelId: channel.id,
                                        threadId: rootId,
                                        ...(intent !== "reply" && {
                                          messageId,
                                        }),
                                      },
                                      { keep: true },
                                    );
                                  }}
                                />
                              </>
                            )}
                          </ConversationHost>
                        </ConversationPresentation>
                      </div>
                    )}
                  </>
                )}
              </PageTabs>
            )}
          </section>
        </div>
      </div>
    </FeedbackMount>
  );
}
