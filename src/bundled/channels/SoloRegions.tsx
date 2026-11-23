import { SoloDisclosure } from "../../features/channel-navigation/SoloDisclosure";
import {
  RegionChannelGroup,
  RegionChannelGroups,
} from "../../features/channel-navigation/RegionChannelGroup";
import {
  WorkspaceCompositionContext,
  RegionWorkspace,
  RegionChats,
  RegionChatList,
  type ComposeWorkspaces,
} from "../../features/channel-navigation/WorkspaceComposition";
import {
  RegionDestinationContext,
  RegionCard,
  RegionConversation,
  RecoveryDestination,
} from "../../features/channel-navigation/SoloDestination";
import {
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import {
  DroppableSidebarSection,
  useSidebarCard,
} from "../../features/channel-navigation/ChannelSidebarDnd";
import styles from "./Channels.module.css";
import type { useSidebarView } from "./useSidebarView";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  SlidersHorizontalIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
} from "../../shared/design-system/ui/Menu";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { relayPartition } from "../../features/relay/partition";
import type { RelaySession } from "../../features/relay/session";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import {
  soloNavigationFor,
  type SoloNavigationService,
} from "../../features/channel-navigation/solo-navigation";
import type { SoloRegion } from "../../features/channel-navigation/solo-navigation-model";
import type {
  SoloRegionAction,
  SoloRegionProps,
} from "../../features/channel-navigation/solo-navigation-contract";

/** Regions with a card, in their sources' order. The first with a source
 * composes ordinary chats wherever its card sits. */
export function visibleSoloRegions(regions: readonly SoloRegion[]) {
  return regions.filter(
    (region) => !region.hidden && region.reason !== "disabled",
  );
}

export function SoloRegions({
  session,
  navigator,
  target,
  sidebar,
  scope,
  ordinary,
  composeOrdinary,
  fallback,
  pendingClick: sharedPendingClick,
  only,
}: {
  session: RelaySession;
  navigator: Navigation;
  target: OpenTarget;
  scope: string;
  sidebar: ReturnType<typeof useSidebarView>;
  ordinary?: ReactNode;
  composeOrdinary?: ((compose: ComposeWorkspaces) => ReactNode) | undefined;
  fallback?: ReactNode;
  pendingClick?: RefObject<ReturnType<typeof setTimeout> | undefined>;
  /** Renders only this region's card; each card is its own sidebar slot. */
  only?: string | undefined;
}) {
  const localPendingClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pendingClick = sharedPendingClick ?? localPendingClick;
  const snapshot = useSoloNavigation(session);
  const service = soloNavigationFor(session);
  const regions = visibleSoloRegions(snapshot.regions);
  const primary = regions.findIndex((region) => region.source);
  if (!service) return fallback ?? null;
  return (
    <>
      {/* Each region renders its card directly, unwrapped, so the cards'
          sibling gap rules reach it like every other card. */}
      {regions.map((region, index) =>
        only !== undefined && region.key !== only ? null : (
          <RegionFrame
            key={`${region.key}:${snapshot.binding?.incarnation ?? "recovery"}`}
            region={region}
            service={service}
            session={session}
            scope={scope}
            navigator={navigator}
            pendingClick={pendingClick}
            target={target}
            sidebar={sidebar}
            ordinary={index === primary ? ordinary : undefined}
            composeOrdinary={index === primary ? composeOrdinary : undefined}
          />
        ),
      )}
      {primary < 0 ? fallback : null}
    </>
  );
}

function RegionFrame({
  scope,
  region,
  service,
  session,
  navigator,
  target,
  sidebar,
  ordinary,
  composeOrdinary,
  pendingClick,
}: {
  scope: string;
  region: SoloRegion;
  service: SoloNavigationService;
  session: RelaySession;
  navigator: Navigation;
  pendingClick: RefObject<ReturnType<typeof setTimeout> | undefined>;
  target: OpenTarget;
  sidebar: ReturnType<typeof useSidebarView>;
  ordinary?: ReactNode;
  composeOrdinary?: ((compose: ComposeWorkspaces) => ReactNode) | undefined;
}) {
  const binding = service.snapshot().binding;
  const source = region.source;
  const [actionError, setActionError] = useState(false);
  const [revealRequest, setRevealRequest] = useState<string>();
  const current =
    target.kind === "conversation" &&
    relayPartition(target.scope.communityOrigin, target.scope.viewer) === scope
      ? target.channelId
      : undefined;
  const sectionKey = `solo-region:${region.key}`;
  // Its menu holds only moves.
  const movable = !!useSidebarCard(sectionKey).move;
  useLayoutEffect(() => {
    // The card itself, so focus inside it can recover when the region leaves.
    const node = document.querySelector(
      `[data-sidebar-section="${CSS.escape(sectionKey)}"]`,
    );
    return () => {
      if (!node?.contains(document.activeElement)) return;
      // Destinations restore their own same-row/neighbor focus before a heading fallback.
      if (document.activeElement?.closest("[data-solo-destination-root]"))
        return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        const candidates = [
          document.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(sectionKey)}"] summary`,
          ),
          document.querySelector<HTMLElement>("[data-solo-heading]"),
          ...document.querySelectorAll<HTMLElement>(
            '[data-sidebar-section^="solo-region:"] summary',
          ),
        ];
        for (const candidate of candidates) {
          if (!candidate || candidate.closest("[hidden], [inert]")) continue;
          candidate.focus();
          if (document.activeElement === candidate) break;
        }
      });
    };
  }, [sectionKey]);
  const presentation = useMemo(
    () =>
      source && binding ? service.presentation(source, binding) : undefined,
    [service, source, binding],
  );
  const { retryReveal, revealAgain } = sidebar;
  const open = !sidebar.collapsed.includes(sectionKey);
  const { channels, live } = region;
  const destination = useMemo(
    () => ({
      channels,
      live,
      session,
      navigator,
      pendingClick,
      scope,
      current,
      active: () =>
        !!binding &&
        service.snapshot().binding === binding &&
        !!source &&
        service.sources().includes(source),
      retryReveal,
    }),
    [
      channels,
      live,
      session,
      navigator,
      pendingClick,
      scope,
      current,
      binding,
      service,
      source,
      retryReveal,
    ],
  );
  const { active } = destination;
  useLayoutEffect(() => {
    if (!revealRequest) return;
    if (revealRequest === current) revealAgain(sectionKey);
    setRevealRequest(undefined);
  }, [current, revealAgain, revealRequest, sectionKey]);
  const reveal = useEffectEvent((id: string, explicit: boolean) => {
    if (!region.channels.some((channel) => channel.id === id)) return false;
    if (explicit && id === current) setRevealRequest(id);
    return true;
  });
  useLayoutEffect(() => service.subscribeReveal(reveal, true), [service]);
  let actions: readonly SoloRegionAction[] = [];
  try {
    if (binding && source?.actions)
      actions = source
        .actions(binding)
        .slice(0, 3)
        .filter(
          (action) =>
            action &&
            typeof action.label === "string" &&
            typeof action.onSelect === "function",
        );
  } catch {
    /* Actions do not fail the region body. */
  }
  const run = async (action: Pick<SoloRegionAction, "onSelect">) => {
    if (!active()) return;
    setActionError(false);
    try {
      await action.onSelect();
    } catch {
      if (active()) setActionError(true);
    }
  };
  const recovery = (
    <>
      <p role={region.reason === "failed" ? "alert" : "status"}>
        {region.reason === "not-installed"
          ? "The plugin for these chats is not installed."
          : region.reason === "off"
            ? "The plugin for these chats is off."
            : region.reason === "loading"
              ? `Loading ${region.title}…`
              : `${region.title} could not load`}
      </p>
      {source ? (
        <Button
          size="sm"
          onClick={() => {
            service.retry(region.key);
          }}
        >
          Retry
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() =>
            void navigator.open({
              version: 1,
              kind: "settings",
              section: "plugins",
            })
          }
        >
          Open plugin settings
        </Button>
      )}
      {region.channels.map((channel) => (
        <RecoveryDestination key={channel.id} channelId={channel.id} />
      ))}
    </>
  );
  const composing = !!source?.composeWorkspaces && !!composeOrdinary;
  // The region's own create action trails its other actions. Composed
  // workspaces show a create menu as actions.
  const create = actions.find((action) => action.icon === "plus");
  const headerActions = (
    <>
      {actions
        .filter((action) => action.icon !== "plus")
        .map((action) => (
          <RegionAction key={action.id} action={action} run={run} />
        ))}
      {create && (
        <RegionAction
          action={
            composing && create.menu
              ? {
                  ...create,
                  icon: <DotsThreeIcon size={15} strokeWidth={2.5} />,
                }
              : create
          }
          run={run}
        />
      )}
    </>
  );
  const headerNotice = actionError && (
    <p className={styles.contributionFeedback} role="alert">
      The action could not run.
    </p>
  );
  const unavailable = (
    <>
      {recovery}
      {composing && <RegionChats all />}
    </>
  );
  const body =
    source &&
    binding &&
    presentation &&
    region.snapshot?.status === "ready" &&
    !region.reason ? (
      <OwnedContribution
        entry={source}
        registry={{ snapshot: service.sources }}
        fallback={unavailable}
      >
        {(entry) => (
          <entry.component
            binding={binding}
            snapshot={region.snapshot as SoloRegionProps["snapshot"]}
            live={region.live}
            {...(current ? { current } : {})}
            {...presentation}
            ui={
              composing
                ? {
                    ...destinationUi,
                    Workspace: RegionWorkspace,
                    Chats: RegionChats,
                    ChatList: RegionChatList,
                  }
                : destinationUi
            }
          />
        )}
      </OwnedContribution>
    ) : (
      unavailable
    );
  const contents = composing
    ? composeOrdinary?.((parts) => (
        <WorkspaceCompositionContext value={parts}>
          {body}
        </WorkspaceCompositionContext>
      ))
    : body;
  return (
    <RegionDestinationContext.Provider value={destination}>
      <DroppableSidebarSection
        // A card drop target that accepts no rows.
        disabled={false}
        accepts={[]}
        sectionKey={sectionKey}
        title={region.title}
        icon={source?.icon}
        open={open}
        onToggle={(open) => sidebar.toggle(sectionKey, open)}
        hideMoreActions={!movable}
        headerActions={headerActions}
        headerNotice={headerNotice}
      >
        <RegionChannelGroups session={session}>{contents}</RegionChannelGroups>
      </DroppableSidebarSection>
      {composing ? null : ordinary}
    </RegionDestinationContext.Provider>
  );
}

function RegionAction({
  action,
  run,
}: {
  action: SoloRegionAction;
  run(action: Pick<SoloRegionAction, "onSelect">): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const afterClose = useRef<Pick<SoloRegionAction, "onSelect"> | undefined>(
    undefined,
  );
  const choose = (item: Pick<SoloRegionAction, "onSelect">) => {
    afterClose.current = item;
    setOpen(false);
  };
  let items: ReturnType<NonNullable<SoloRegionAction["menu"]>> | undefined;
  try {
    items = action
      .menu?.()
      .slice(0, 32)
      .filter(
        (item) =>
          item &&
          typeof item.label === "string" &&
          typeof item.onSelect === "function",
      );
  } catch {
    return null;
  }
  const icon =
    action.icon === "plus" ? (
      <PlusIcon size={15} strokeWidth={2.5} />
    ) : action.icon === "view" ? (
      <SlidersHorizontalIcon size={15} />
    ) : (
      action.icon
    );
  const trigger = (
    <IconButton
      ref={anchor}
      size="compact"
      icon={icon}
      aria-label={action.label}
      title={action.label}
    />
  );
  if (!items)
    return (
      <IconButton
        size="compact"
        icon={icon}
        aria-label={action.label}
        title={action.label}
        onClick={() => void run(action)}
      />
    );
  items ??= [{ id: action.id, label: action.label, onSelect: action.onSelect }];
  if (!items.length) return null;
  const groups = [...new Set(items.map((item) => item.group ?? ""))];
  return (
    <MenuRoot
      open={open}
      onOpenChange={(next) => {
        if (next) afterClose.current = undefined;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const item = afterClose.current;
        afterClose.current = undefined;
        if (!item) return;
        // Like tab-menu rename, wait for the menu's focus scope before opening a dialog.
        anchor.current?.focus({ preventScroll: true });
        void run(item);
      }}
    >
      <MenuTrigger render={trigger} />
      <MenuPopup align="end" size="compact" aria-label={action.label}>
        {groups.map((name) => {
          const group = items.filter((item) => (item.group ?? "") === name);
          return (
            <MenuGroup key={name}>
              {name && <MenuGroupLabel>{name}</MenuGroupLabel>}
              {group.some((item) => typeof item.checked === "boolean") && (
                <MenuRadioGroup
                  value={group.find((item) => item.checked)?.id ?? ""}
                >
                  {group
                    .filter((item) => typeof item.checked === "boolean")
                    .map((item) => (
                      <MenuRadioItem
                        key={item.id}
                        value={item.id}
                        onClick={() => choose(item)}
                      >
                        {item.label}
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
              )}
              {group
                .filter((item) => typeof item.checked !== "boolean")
                .map((item) => (
                  <MenuItem key={item.id} onClick={() => choose(item)}>
                    {item.label}
                  </MenuItem>
                ))}
            </MenuGroup>
          );
        })}
      </MenuPopup>
    </MenuRoot>
  );
}

const destinationUi = {
  Conversation: RegionConversation,
  Card: RegionCard,
  Disclosure: SoloDisclosure,
  ChannelGroup: RegionChannelGroup,
};
