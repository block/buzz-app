import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { RelaySession } from "../relay/session";
import { Collapsible } from "@base-ui/react/collapsible";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  NavigationSectionHeading,
  type NavigationSectionTrailing,
} from "../../shared/design-system/ui/NavigationSection";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Cube3dSphereIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { workspaceSectionOrder } from "../relay/sidebar-preferences";
import { WorkspaceSettings } from "../solo/WorkspaceSettings";
import { SoloDisclosure } from "./SoloDisclosure";
import { RegionDestinationContext } from "./SoloDestination";
import type { SoloWorkspaceProps } from "./solo-navigation-contract";
import channelStyles from "../../bundled/channels/Channels.module.css";
import workspaceStyles from "../../bundled/channels/SoloWorkspaces.module.css";
import styles from "./WorkspaceComposition.module.css";

export type WorkspaceHeaderTrailing = NavigationSectionTrailing & {
  hasInteractiveDecoration: boolean;
};

/** The existing Solo inventory retains every row, menu, mutation and disclosure. */
export type WorkspaceComposition = Readonly<{
  ordinary: ReactNode;
  chats: ReactNode;
  chatList: ReactNode;
  workspaces: readonly Readonly<{
    id: string;
    name: string;
    open: boolean;
    toggle(open: boolean): void;
    frame(children: ReactNode): ReactNode;
    header(
      primary: ReactNode,
      newTask?: ReactNode,
      actions?: ReactNode,
      trailing?: WorkspaceHeaderTrailing,
    ): ReactNode;
    panel(before?: ReactNode): ReactNode;
  }>[];
}>;
export type ComposeWorkspaces = (parts: WorkspaceComposition) => ReactNode;
export const WorkspaceCompositionContext = createContext<
  WorkspaceComposition | undefined
>(undefined);

export type RegionWorkspaceHost = Readonly<{
  sectionKey: string;
  collapsed: readonly string[];
  toggle(key: string, open: boolean): void;
}>;
export const RegionWorkspaceHostContext = createContext<
  RegionWorkspaceHost | undefined
>(undefined);

const noSubscription = () => () => {};
const emptyPreferencesSnapshot: ReturnType<
  RelaySession["sidebarPreferences"]["snapshot"]
> = {
  status: "idle",
};
const readEmptyPreferences = () => emptyPreferencesSnapshot;

/** Ordinary chats remain available in task views that group by status or time. */
export function RegionChats({ all = false }: { all?: boolean }) {
  const parts = useContext(WorkspaceCompositionContext);
  return (all ? parts?.ordinary : parts?.chats) ?? null;
}

/** All ordinary chats without workspace headings or collapse controls. */
export function RegionChatList() {
  const list = useContext(WorkspaceCompositionContext)?.chatList;
  return list ? <div data-solo-chat-list="">{list}</div> : null;
}

function renderWorkspaceHeading({
  id,
  title,
  selected,
  onSelect,
  leading,
  disclosure,
}: {
  id: string;
  title: string;
  selected?: boolean | undefined;
  onSelect?: (() => void) | undefined;
  leading: SoloWorkspaceProps["headerLeading"];
  disclosure: ReactNode;
}) {
  return (
    <div className={styles.heading}>
      {leading && disclosure}
      <NavigationItem
        label={title}
        icon={leading && <Cube3dSphereIcon size={14} aria-hidden="true" />}
        selected={!!selected}
        data-solo-workspace-id={id}
        onClick={() => onSelect?.()}
      />
      {!leading && disclosure}
    </div>
  );
}

function WorkspaceSourceMenuActions({
  leading,
  onNewTask,
  headerMenuActions,
  runAction,
}: {
  leading: SoloWorkspaceProps["headerLeading"];
  onNewTask?: (() => void) | undefined;
  headerMenuActions?: SoloWorkspaceProps["headerMenuActions"];
  runAction?:
    | ((action: () => void | Promise<void>) => Promise<void>)
    | undefined;
}) {
  return (
    <>
      {leading && (
        <MenuItem onClick={leading.onActivate}>{leading.label}</MenuItem>
      )}
      {onNewTask && <MenuItem onClick={onNewTask}>New task</MenuItem>}
      {headerMenuActions?.map((action) => (
        <MenuItem
          key={action.id}
          onClick={() => void runAction?.(() => action.onSelect())}
        >
          {action.label}
        </MenuItem>
      ))}
    </>
  );
}

function WorkspaceNewTaskButton({
  title,
  onNewTask,
}: {
  title: string;
  onNewTask?: (() => void) | undefined;
}) {
  if (!onNewTask) return null;
  return (
    <IconButton
      size="compact"
      data-solo-workspace-new-task=""
      aria-label={`New task in ${title}`}
      title="New task"
      icon={<PlusIcon size={15} strokeWidth={2.5} />}
      onClick={onNewTask}
    />
  );
}

/** One shared workspace surface. A source supplies its tasks and selection. */
export function RegionWorkspace(props: SoloWorkspaceProps) {
  const parts = useContext(WorkspaceCompositionContext);
  const destination = useContext(RegionDestinationContext);
  if (!parts) return <IndependentRegionWorkspace {...props} />;
  const workspace = parts.workspaces.find(
    (item) => item.id === (props.id ?? ""),
  );
  if (!workspace || !props.id) return null;
  const title = props.id ? workspace.name : "Unfiled";
  const leading = props.headerLeading;
  const accessory =
    props.headerAccessory != null && typeof props.headerAccessory !== "boolean"
      ? props.headerAccessory
      : undefined;
  const disclosure = (
    <SoloDisclosure
      leading={leading}
      label={`${workspace.open ? "Hide" : "Show"} tasks and chats in ${title}`}
      summary={props.id ? "" : title}
      expanded={workspace.open}
      controls={`workspace-${workspace.id || "unfiled"}`}
      onToggle={() => workspace.toggle(!workspace.open)}
    />
  );
  const primary = renderWorkspaceHeading({
    id: workspace.id,
    title,
    selected: props.selected,
    onSelect: props.onSelect,
    leading,
    disclosure,
  });
  return workspace.frame(
    <div data-solo-workspace={workspace.id}>
      <NavigationCard
        tone="tonal"
        data-drop-target={props.dropTarget || undefined}
        body={workspace.panel(props.children)}
      >
        {workspace.header(
          primary,
          props.onNewTask && (
            <WorkspaceNewTaskButton title={title} onNewTask={props.onNewTask} />
          ),
          <WorkspaceSourceMenuActions
            leading={leading}
            onNewTask={props.onNewTask}
            headerMenuActions={props.headerMenuActions}
            runAction={destination?.runAction}
          />,
          {
            accessory,
            metadata: props.headerMetadata,
            hasInteractiveDecoration: !!leading || accessory != null,
          },
        )}
      </NavigationCard>
    </div>,
  );
}

/** Native workspace chrome for an independent source without consuming ordinary chats. */
function IndependentRegionWorkspace(props: SoloWorkspaceProps) {
  const destination = useContext(RegionDestinationContext);
  const host = useContext(RegionWorkspaceHostContext);
  const preferences = destination?.session.sidebarPreferences;
  const snapshot = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    preferences?.snapshot ?? readEmptyPreferences,
    preferences?.snapshot ?? readEmptyPreferences,
  );
  useEffect(() => {
    if (preferences && snapshot.status === "idle") void preferences.ensure();
  }, [preferences, snapshot.status]);
  const panelId = useId();
  const headerRef = useRef<HTMLDivElement>(null);
  const openingSettings = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<HTMLElement>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const sectionKey = host?.sectionKey;
  useLayoutEffect(() => {
    const header = headerRef.current;
    return () => {
      if (!header?.contains(document.activeElement)) return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        const summary = sectionKey
          ? document.querySelector<HTMLElement>(
              `[data-sidebar-section="${CSS.escape(sectionKey)}"] summary`,
            )
          : null;
        if (summary && !summary.closest("[hidden], [inert]"))
          summary.focus({ preventScroll: true });
      });
    };
  }, [sectionKey]);
  if (
    !destination ||
    !host ||
    !preferences ||
    !props.id ||
    !destination.active()
  )
    return null;
  const order = workspaceSectionOrder(snapshot.data);
  const sections = snapshot.data?.sections ?? [];
  const groups = snapshot.data?.sectionOrder
    ? order.flatMap((key) => sections.filter(({ id }) => key === `group:${id}`))
    : sections;
  const groupIndex = groups.findIndex((group) => group.id === props.id);
  const section = groups[groupIndex];
  if (!section) return null;
  const title = section.name;
  const collapseKey = `${host.sectionKey}:workspace:${section.id}`;
  const open = !host.collapsed.includes(collapseKey);
  const leading = props.headerLeading;
  const accessory =
    props.headerAccessory != null && typeof props.headerAccessory !== "boolean"
      ? props.headerAccessory
      : undefined;
  const hasInteractiveDecoration = !!leading || accessory != null;
  const orderWritable = preferences.sectionOrderWritable;
  const moveWorkspace = (to: number) => {
    const ids = groups
      .map((group) => group.id)
      .filter((key) => key !== section.id);
    ids.splice(to, 0, section.id);
    if (!snapshot.data?.sectionOrder) {
      void preferences.reorderSections(section.id, ids).catch(() => {});
      return;
    }
    let next = 0;
    const reordered = order.map((key) =>
      key.startsWith("group:") ? `group:${ids[next++]}` : key,
    );
    void preferences
      .reorderSections(`group:${section.id}`, reordered)
      .catch(() => {});
  };
  const restoreFocus = () =>
    headerRef.current?.querySelector<HTMLElement>("[data-solo-workspace-id]") ??
    false;
  const menuFinalFocus = () => {
    if (openingSettings.current) {
      openingSettings.current = false;
      return false as const;
    }
    return restoreFocus();
  };
  const ownsContextTarget = ({ target, currentTarget }: SyntheticEvent) =>
    target instanceof Element &&
    currentTarget.contains(target) &&
    !target.closest(
      "[data-solo-workspace-accessory], [data-solo-leading-action]",
    );
  const menuContent = (
    <>
      <WorkspaceSourceMenuActions
        leading={leading}
        onNewTask={props.onNewTask}
        headerMenuActions={props.headerMenuActions}
        runAction={destination.runAction}
      />
      <MenuItem
        disabled={!orderWritable || groupIndex <= 0}
        onClick={() => moveWorkspace(groupIndex - 1)}
      >
        <MenuIcon>
          <ArrowUpIcon size={14} />
        </MenuIcon>
        Move up
      </MenuItem>
      <MenuItem
        disabled={!orderWritable || groupIndex >= groups.length - 1}
        onClick={() => moveWorkspace(groupIndex + 1)}
      >
        <MenuIcon>
          <ArrowDownIcon size={14} />
        </MenuIcon>
        Move down
      </MenuItem>
      <MenuItem
        onClick={() => {
          openingSettings.current = true;
          requestAnimationFrame(() => {
            if (mounted.current && destination.active()) setSettingsOpen(true);
          });
        }}
      >
        Workspace settings
      </MenuItem>
      <MenuItem
        tone="danger"
        data-delete-solo-project=""
        disabled={!preferences.sectionRemovalWritable || deleting}
        onClick={() => {
          setDeleting(true);
          setDeleteError("");
          void preferences
            .removeSection(section.id)
            .catch((error: unknown) => {
              if (mounted.current)
                setDeleteError(
                  error instanceof Error
                    ? error.message
                    : "Workspace could not be deleted. Try again.",
                );
            })
            .finally(() => {
              if (mounted.current) setDeleting(false);
            });
        }}
      >
        Delete workspace
      </MenuItem>
    </>
  );
  const overflow = (
    <MenuRoot>
      <MenuTrigger
        render={(triggerProps) => (
          <IconButton
            {...triggerProps}
            variant="bare"
            size="compact"
            aria-label={`Actions for ${title}`}
            icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
          />
        )}
      />
      <MenuPopup
        aria-label={`Actions for ${title}`}
        align="end"
        finalFocus={menuFinalFocus}
      >
        {menuContent}
      </MenuPopup>
    </MenuRoot>
  );
  const disclosure = (
    <SoloDisclosure
      leading={leading}
      label={`${open ? "Hide" : "Show"} tasks in ${title}`}
      summary=""
      expanded={open}
      controls={panelId}
      onToggle={() => host.toggle(collapseKey, !open)}
    />
  );
  const newTask = props.onNewTask && (
    <WorkspaceNewTaskButton title={title} onNewTask={props.onNewTask} />
  );
  return (
    <Collapsible.Root
      className={`${workspaceStyles.project} ${channelStyles.channelSection}`}
      data-project=""
      open={open}
      onOpenChange={(next) => host.toggle(collapseKey, next)}
    >
      <div data-solo-workspace={section.id}>
        <NavigationCard
          tone="tonal"
          data-drop-target={props.dropTarget || undefined}
          body={
            <Collapsible.Panel
              keepMounted
              className={workspaceStyles.projectPanel}
              id={panelId}
            >
              {props.children}
            </Collapsible.Panel>
          }
        >
          <ContextMenuRoot
            open={contextMenuOpen}
            onOpenChange={(next) => {
              setContextMenuOpen(next);
              if (!next) setContextMenuAnchor(undefined);
            }}
          >
            <ContextMenuTrigger
              render={
                <div
                  ref={headerRef}
                  className={workspaceStyles.workspaceHeader}
                  data-solo-menu-id={`${host.sectionKey}:project-${section.id}`}
                />
              }
              onContextMenu={(event) => {
                if (hasInteractiveDecoration && !ownsContextTarget(event))
                  event.preventBaseUIHandler();
              }}
              onTouchStart={(event) => {
                if (hasInteractiveDecoration && !ownsContextTarget(event))
                  event.preventBaseUIHandler();
              }}
              onKeyDown={(event) => {
                if (hasInteractiveDecoration && !ownsContextTarget(event))
                  return;
                if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenuAnchor(event.currentTarget);
                  setContextMenuOpen(true);
                }
              }}
            >
              <NavigationSectionHeading
                disclosure
                revealActions="in-flow"
                trailing={{
                  metadata: props.headerMetadata,
                  accessory: accessory != null && (
                    <div
                      className="relative flex shrink-0 items-center"
                      data-solo-workspace-accessory=""
                    >
                      {accessory}
                    </div>
                  ),
                }}
                actions={
                  <>
                    {hasInteractiveDecoration && newTask}
                    {overflow}
                    {!hasInteractiveDecoration && newTask}
                  </>
                }
              >
                {renderWorkspaceHeading({
                  id: section.id,
                  title,
                  selected: props.selected,
                  onSelect: props.onSelect,
                  leading,
                  disclosure,
                })}
              </NavigationSectionHeading>
            </ContextMenuTrigger>
            <MenuPopup
              aria-label={`Actions for ${title}`}
              anchor={contextMenuAnchor}
              finalFocus={menuFinalFocus}
            >
              {menuContent}
            </MenuPopup>
          </ContextMenuRoot>
        </NavigationCard>
        {deleteError && (
          <p role="alert" className={workspaceStyles.listMessage}>
            {deleteError}
          </p>
        )}
        {settingsOpen && (
          <WorkspaceSettings
            session={destination.session}
            scope={destination.scope}
            target={{
              kind: "project",
              id: section.id,
              name: section.name,
              icon: section.icon,
            }}
            finalFocus={restoreFocus}
            close={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </Collapsible.Root>
  );
}
