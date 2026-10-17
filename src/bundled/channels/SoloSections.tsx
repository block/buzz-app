import {
  conversionLabel,
  useChatConversions,
} from "../../features/solo/conversion";
import {
  sessionShareAttempt,
  useSessionShareAttempts,
} from "../../features/solo/share-attempt";
import {
  ConvertToChannel,
  canConvertToChannel,
} from "../../features/solo/ConvertToChannel";
import { SoloShare, SessionAccessIndicator } from "./SoloShare";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { Collapsible } from "@base-ui/react/collapsible";
import { useDroppable } from "@dnd-kit/core";
import {
  ChannelSidebarDnd,
  DraggableChannel,
} from "../../features/channel-navigation/ChannelSidebarDnd";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  PlusIcon,
  CopyIcon,
  GearIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { Navigation } from "../../features/navigation/controller";
import styles from "./SoloSections.module.css";
import channelStyles from "./Channels.module.css";

/** Presentation only. The caller supplies authorized, saved chats. */
export type SessionListItem = Readonly<{ id: string; title: string }>;

/** The existing relay preference service owns delivery, rollback and retry. */
export function SoloSections({
  session,
  navigator: navigationController,
  scope,
  sessions,
  renderSession,
  onNew,
  onConverted,
  visit,
}: {
  onConverted?: ((id: string) => void) | undefined;
  visit?: AbortSignal;
  session: RelaySession;
  navigator?: Navigation | undefined;
  scope: string;
  sessions: readonly SessionListItem[];
  renderSession: (item: SessionListItem) => ReactNode;
  onNew?: (projectId?: string) => void;
}) {
  useChatConversions(session);
  const shareAttempts = useSessionShareAttempts(session);
  const [copyNotice, setCopyNotice] = useState<{
    text: string;
    error: boolean;
  }>();
  const copying = useRef(false);
  const copy = async (value: string, label: string) => {
    if (copying.current) return;
    copying.current = true;
    setCopyNotice(undefined);
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice({ text: `${label} copied`, error: false });
    } catch {
      setCopyNotice({
        text: "Couldn’t copy. Try again from the session menu.",
        error: true,
      });
    } finally {
      copying.current = false;
    }
  };
  const preferences = session.soloPreferences;
  const collapsedKey = "me:collapsed-sections";
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  useEffect(() => {
    if (channels.status === "ready") void preferences.ensure();
  }, [preferences, channels.status]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, collapsedKey, []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const [sharing, setSharing] = useState<{
    id: string;
    visit: AbortSignal | undefined;
  }>();
  const sharingChannel = channels.channels.find(
    (channel) => channel.id === sharing?.id,
  );
  const [converting, setConverting] = useState<{
    id: string;
    visit: AbortSignal | undefined;
  }>();
  const currentVisit = useRef(visit);
  currentVisit.current = visit;
  const [sessionSettings, setSessionSettings] = useState<{
    item: SessionListItem;
    visit: AbortSignal | undefined;
  }>();
  const [deleting, setDeleting] = useState<string>();
  const [sectionError, setSectionError] = useState("");
  const [animate, setAnimate] = useState(false);
  const [rowFocus, setRowFocus] = useState<string>();
  useLayoutEffect(() => {
    if (!rowFocus) return;
    document
      .querySelector<HTMLElement>(`[data-session-menu-id="${rowFocus}"] button`)
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus]);
  const [creatingFor, setCreatingFor] = useState<SessionListItem>();
  const [settingsFor, setSettingsFor] = useState<{
    id: string;
    name: string;
  }>();
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments ?? {};
  const ids = new Set(groups.map((group) => group.id));
  const sections = [
    ...groups.map((group) => ({
      ...group,
      rows: sessions.filter((item) => assigned[item.id] === group.id),
    })),
    {
      id: "",
      name: "Chats",
      rows: sessions.filter((item) => !ids.has(assigned[item.id] ?? "")),
    },
  ];
  const move = (id: string, projectId?: string) => {
    const saving = preferences.assign(id, projectId);
    toggle(projectId ?? "", true);
    setRowFocus(id);
    void saving.catch(() => {
      // A rollback remounts the original row. Do not steal focus if the user moved on.
      if (
        !document.querySelector(`[data-session-menu-id="${id}"]`) ||
        document.activeElement !== document.body
      )
        return;
      setRowFocus(id);
    });
  };
  const toggle = (id: string, open: boolean) => {
    const next = open
      ? collapsed.filter((key) => key !== id)
      : [...collapsed, id];
    setCollapsed(next);
    writeView(scope, collapsedKey, next);
  };
  const moves =
    snapshot.moves?.filter((move) =>
      sessions.some((item) => item.id === move.channelId),
    ) ?? [];
  return (
    <>
      {(snapshot.status === "idle" || snapshot.status === "loading") && (
        <p role="status" className={styles.listMessage}>
          Loading sections…
        </p>
      )}
      {snapshot.status === "error" && (
        <div role="alert" className={styles.listMessage}>
          <p>{snapshot.error ?? "Sections couldn’t load."}</p>
          <Button onClick={() => void preferences.refresh()}>
            Retry sections
          </Button>
        </div>
      )}
      {sectionError && (
        <p role="alert" className={styles.listMessage}>
          {sectionError}
        </p>
      )}
      <ChannelSidebarDnd
        writable={preferences.writable}
        onMove={(id, key) => move(id, key.slice(DROP.length) || undefined)}
        // Me projects keep their saved order; only chats drag.
        onReorder={() => {}}
        overlay={(id) => {
          const item = sessions.find((item) => item.id === id);
          return (
            item && (
              <div className={channelStyles.channelDragOverlay}>
                <span>{item.title}</span>
              </div>
            )
          );
        }}
      >
        {sections
          .filter((section) => section.id || section.rows.length)
          .map((section) => (
            <DropSection
              sectionKey={DROP + section.id}
              key={section.id}
              className={`${styles.section} ${channelStyles.channelSection}`}
              data-project={section.id ? "" : undefined}
              open={!collapsed.includes(section.id)}
              onOpenChange={(open) => toggle(section.id, open)}
              data-animate={animate || undefined}
            >
              <SessionActionsMenu
                id={`section-${section.id}`}
                title={section.name}
                className={`${channelStyles.sectionHeader} ${styles.sectionHeader}`}
                enabled={!!section.id}
                trailing={
                  <div className={channelStyles.sectionActions}>
                    {onNew && (
                      <IconButton
                        size="compact"
                        aria-label={`New chat in ${section.name}`}
                        title="New chat"
                        icon={<PlusIcon size={15} strokeWidth={2.5} />}
                        onClick={() => onNew(section.id || undefined)}
                      />
                    )}
                  </div>
                }
                content={
                  <>
                    <MenuItem onClick={() => setSettingsFor(section)}>
                      Project settings…
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      data-delete-session-section=""
                      disabled={
                        !preferences.sectionRemovalWritable || !!deleting
                      }
                      onClick={() => {
                        setDeleting(section.id);
                        setSectionError("");
                        void preferences
                          .removeSection(section.id)
                          .catch((error: unknown) => {
                            setSectionError(
                              error instanceof Error
                                ? error.message
                                : "Section could not be deleted. Try again.",
                            );
                          })
                          .finally(() => setDeleting(undefined));
                      }}
                    >
                      Delete project
                    </MenuItem>
                  </>
                }
              >
                <Collapsible.Trigger
                  type="button"
                  className={`${channelStyles.sidebarSectionHeading} ${styles.sectionHeading}`}
                  aria-expanded={!collapsed.includes(section.id)}
                  onClick={(event) => setAnimate(event.detail > 0)}
                >
                  <span className={channelStyles.sectionTitle}>
                    {section.name}
                  </span>
                  <span
                    className={channelStyles.sectionChevron}
                    aria-hidden="true"
                  >
                    <CaretDownIcon size={15} strokeWidth={2.5} />
                  </span>
                </Collapsible.Trigger>
              </SessionActionsMenu>
              <Collapsible.Panel className={styles.sectionPanel}>
                {section.rows.map((item) => (
                  <SessionActionsMenu
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    indicator={
                      <SessionAccessIndicator
                        session={session}
                        channel={channels.channels.find(
                          (channel) => channel.id === item.id,
                        )}
                        onClick={() => setSharing({ id: item.id, visit })}
                      />
                    }
                    className={styles.organizedRow}
                    content={
                      <>
                        <MenuItem
                          onClick={() => setSharing({ id: item.id, visit })}
                        >
                          Share…
                        </MenuItem>
                        {canConvertToChannel(
                          session,
                          channels.channels.find(
                            (channel) => channel.id === item.id,
                          ),
                        ) && (
                          <MenuItem
                            disabled={shareAttempts.has(item.id)}
                            onClick={() => {
                              if (!sessionShareAttempt(session, item.id))
                                setConverting({ id: item.id, visit });
                            }}
                          >
                            {conversionLabel(session, item.id)}
                          </MenuItem>
                        )}
                        <MenuSubmenu>
                          <MenuSubmenuTrigger disabled={!preferences.writable}>
                            <MenuIcon>
                              <FolderSimpleIcon size={16} />
                            </MenuIcon>
                            Move to
                          </MenuSubmenuTrigger>
                          <MenuSubmenuPopup aria-label="Session section">
                            {section.id && (
                              <MenuItem onClick={() => move(item.id)}>
                                Chats
                              </MenuItem>
                            )}
                            {groups.map((group) => (
                              <MenuItem
                                key={group.id}
                                onClick={() => move(item.id, group.id)}
                              >
                                {group.name}
                              </MenuItem>
                            ))}
                            <MenuItem onClick={() => setCreatingFor(item)}>
                              New project…
                            </MenuItem>
                          </MenuSubmenuPopup>
                        </MenuSubmenu>
                        <MenuSubmenu>
                          <MenuSubmenuTrigger>
                            <MenuIcon>
                              <CopyIcon size={16} />
                            </MenuIcon>
                            Copy
                          </MenuSubmenuTrigger>
                          <MenuSubmenuPopup aria-label="Copy chat">
                            <MenuItem
                              onClick={() => void copy(item.title, "Chat name")}
                            >
                              Copy chat name
                            </MenuItem>
                            <MenuItem
                              onClick={() => void copy(item.id, "Chat ID")}
                            >
                              Copy chat ID
                            </MenuItem>
                            <MenuItem
                              onClick={() =>
                                void copy(
                                  `buzz://channel/${encodeURIComponent(item.id)}`,
                                  "Session link",
                                )
                              }
                            >
                              Copy link to session
                            </MenuItem>
                          </MenuSubmenuPopup>
                        </MenuSubmenu>

                        <MenuItem
                          disabled={
                            (!session.canvas.available &&
                              !canEditLifetime(
                                session,
                                channels.channels.find(
                                  (channel) => channel.id === item.id,
                                ),
                              )) ||
                            !!channels.channels.find(
                              (channel) => channel.id === item.id,
                            )?.readOnly
                          }
                          onClick={() => setSessionSettings({ item, visit })}
                        >
                          <MenuIcon>
                            <GearIcon size={16} />
                          </MenuIcon>
                          Chat settings…
                        </MenuItem>
                      </>
                    }
                  >
                    <DraggableChannel
                      channelId={item.id}
                      sectionKey={DROP + section.id}
                    >
                      {renderSession(item)}
                    </DraggableChannel>
                  </SessionActionsMenu>
                ))}
                {!section.rows.length &&
                  section.id &&
                  (onNew ? (
                    // An empty project offers its way out instead of an empty state.
                    <NavigationItem
                      variant="row"
                      label="New chat"
                      aria-label={`New chat in ${section.name}`}
                      title={`New chat in ${section.name}`}
                      icon={
                        <span className="shell-page-icon">
                          <PlusIcon size={16} strokeWidth={2.5} />
                        </span>
                      }
                      onClick={() => onNew(section.id)}
                    />
                  ) : (
                    <p className={styles.listMessage}>
                      No chats in this project.
                    </p>
                  ))}
              </Collapsible.Panel>
            </DropSection>
          ))}
      </ChannelSidebarDnd>
      {converting && (
        <ConvertToChannel
          key={converting.id}
          session={session}
          id={converting.id}
          signal={converting.visit}
          onConverted={() => onConverted?.(converting.id)}
          close={() => setConverting(undefined)}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-session-menu-id="${converting.id}"] button`,
            ) ?? false
          }
        />
      )}
      {sharing && sharingChannel && (
        <SoloShare
          key={sharing.id}
          navigator={navigationController}
          session={session}
          channel={sharingChannel}
          signal={sharing.visit}
          onConverted={() => onConverted?.(sharing.id)}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-session-menu-id="${sharing.id}"] button`,
            ) ?? false
          }
          initialOpen
          renderTrigger={() => null}
          onClose={() => setSharing(undefined)}
        />
      )}
      {sessionSettings && (
        <WorkspaceSettings
          key={sessionSettings.item.id}
          signal={sessionSettings.visit}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-session-menu-id="${sessionSettings.item.id}"] button`,
            ) ?? false
          }
          session={session}
          scope={scope}
          target={{
            kind: "session",
            id: sessionSettings.item.id,
            name: sessionSettings.item.title,
          }}
          close={() => setSessionSettings(undefined)}
        />
      )}
      {moves.some((move) => move.pending) && (
        <p role="status" className={styles.listMessage}>
          Saving project…
        </p>
      )}
      {moves
        .filter((move) => move.error)
        .map((move) => (
          <div role="alert" key={move.id} className={styles.listMessage}>
            <p>{move.error}</p>
            <Button
              disabled={!preferences.writable}
              onClick={() =>
                void preferences.retryMove(move.channelId).catch(() => {})
              }
            >
              Retry move
            </Button>
            <Button
              onClick={() => preferences.dismissMoveError(move.channelId)}
            >
              Dismiss
            </Button>
          </div>
        ))}
      {copyNotice && (
        <ToastNotice
          title={copyNotice.text}
          tone={copyNotice.error ? "error" : "success"}
          timeout={copyNotice.error ? 0 : 4000}
          onDismiss={() => setCopyNotice(undefined)}
        />
      )}
      {settingsFor && (
        <WorkspaceSettings
          key={settingsFor.id}
          session={session}
          scope={scope}
          target={{ kind: "section", ...settingsFor }}
          close={() => setSettingsFor(undefined)}
        />
      )}
      {creatingFor && (
        <NewSection
          key={creatingFor.id}
          name={creatingFor.title}
          close={() => setCreatingFor(undefined)}
          create={(name) => {
            if (!preferences.writable) return false;
            const id = crypto.randomUUID();
            void preferences
              .createAndAssign(creatingFor.id, { id, name })
              .catch(() => {});
            toggle(id, true);
            setCreatingFor(undefined);
            return true;
          }}
        />
      )}
    </>
  );
}

const DROP = "section:";

/** A drop reports only its destination, so it saves exactly like Move to. */
function DropSection({
  sectionKey,
  ...props
}: ComponentProps<typeof Collapsible.Root> & { sectionKey: string }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: sectionKey });
  return (
    <Collapsible.Root
      {...props}
      ref={setNodeRef}
      data-drop-target={
        (isOver && active?.data.current?.sectionKey !== sectionKey) || undefined
      }
    />
  );
}

function NewSection({
  name,
  create,
  close,
}: {
  name: string;
  create: (name: string) => boolean;
  close: () => void;
}) {
  const [value, setValue] = useState("");
  const [blocked, setBlocked] = useState(false);
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Create new project"
      description={`Move ${name} into a personal project that syncs across Buzz.`}
      initialFocus={input}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!value.trim()}
          >
            Create and move
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) setBlocked(!create(value.trim()));
        }}
      >
        <Input
          ref={input}
          aria-label="Project name"
          placeholder="Project name"
          required
          maxLength={80}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
      {blocked && (
        <p role="alert">
          Projects are unavailable. Close this dialog and retry.
        </p>
      )}
    </Dialog>
  );
}

/** Both entry points use one action list; right-click never selects the row. */
function SessionActionsMenu({
  id,
  title,
  className,
  children,
  content,
  indicator,
  enabled = true,
  trailing,
}: {
  id: string;
  title: string;
  className: string | undefined;
  children: ReactNode;
  content: ReactNode;
  indicator?: ReactNode;
  enabled?: boolean;
  /** Follows the overflow action, preserving header action keyboard order. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const restoreFocus = () =>
    document.querySelector<HTMLElement>(
      `[data-session-menu-id="${id}"] button`,
    ) ?? false;
  if (!enabled)
    return (
      <div className={className}>
        {children}
        {trailing}
      </div>
    );
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
    >
      <ContextMenuTrigger
        render={<div className={className} data-session-menu-id={id} />}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      >
        {children}
        {indicator}
        <MenuRoot>
          <MenuTrigger
            render={(props) => (
              <IconButton
                {...props}
                data-session-row-action=""
                size="compact"
                data-session-overflow-action=""
                aria-label={`Actions for ${title}`}
                icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
              />
            )}
          />
          <MenuPopup
            aria-label={`Actions for ${title}`}
            align="end"
            finalFocus={restoreFocus}
          >
            {content}
          </MenuPopup>
        </MenuRoot>
        {trailing}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${title}`}
        anchor={anchor}
        finalFocus={restoreFocus}
      >
        {content}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
