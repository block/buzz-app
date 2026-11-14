import { holdsCopy, ownSection, railSections } from "./rail-sections";
import { motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useDndContext,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  PlusIcon,
  ChatCircleIcon,
  ArrowRightIcon,
  FolderSimpleIcon,
  GripHorizontalIcon,
  MinusIcon,
  PencilSimpleIcon,
  PinIcon,
  TrashIcon,
  SquaresFourIcon,
} from "../../shared/design-system/icons";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import { Input } from "../../shared/design-system/ui/Input";
import type { RailEntry } from "./rail-pins";
import { useRailLayout } from "./rail-layout";
import styles from "./RailArrangement.module.css";
import { Header } from "../../shared/design-system/ui/Header";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import feedStyles from "../../features/conversation/FeedList.module.css";

type Group = {
  id: string;
  title: string;
  icon?: ReactElement;
  content: ReactNode;
};
type Arrangement = {
  pageSection?: string | undefined;
  selectedSection?: string | undefined;
  openSection(id: string): void;
  groups: { id: string; title: string }[];
  placements: ReturnType<typeof useRailLayout>["layout"]["placements"];
  membership: ReturnType<typeof railSections>;
  /** Places an entry in a section; it leaves `from` when it moves from there. */
  move(entry: RailEntry, section: string, from?: string): void;
  /** Takes an entry out of a section a person put it in. */
  unplace(entry: RailEntry, section: string): void;
  reorder(id: string, over: string): void;
  create(entry: RailEntry, from?: string): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  renderEntry(entry: RailEntry, section?: string): ReactNode;
  renderSectionList?:
    | ((
        id: string,
        title: string,
        entries: readonly RailEntry[],
        action: ReactNode,
      ) => ReactNode)
    | undefined;
  renderRowActions?:
    | ((entry: RailEntry, close: () => void, focus: () => void) => ReactNode)
    | undefined;
  isPinned(entry: RailEntry): boolean;
  onTogglePin(entry: RailEntry, pinned: boolean): void;
};
const ArrangementContext = createContext<Arrangement | null>(null);
/** Whether rows sit in a section's full list, beside the cards. */
const ListedContext = createContext(false);
/** What a finished drag asks of the cards: set by the arrangement showing them. */
type DragHandlers = {
  end(event: DragEndEvent): void;
  cancel(): void;
};
const DragHostContext = createContext<{
  current: DragHandlers | undefined;
} | null>(null);
const touchOptions = { activationConstraint: { delay: 250, tolerance: 5 } };
const pointerOptions = { activationConstraint: { distance: 6 } };
const collisions: CollisionDetection = (args) =>
  pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((item) =>
      args.active.data.current?.section
        ? item.id !== "rail:new-section"
        : item.id !== "rail:top",
    ),
  });

/**
 * One drag context for the cards and the list beside them, so a row in the
 * list drops onto a card. The shell holds it around both; the arrangement
 * showing the cards decides what a drop does.
 */
export function RailDrag({ children }: { children: ReactNode }) {
  const handlers = useRef<DragHandlers | undefined>(undefined);
  const [dragging, setDragging] = useState<{ label: string }>();
  const sensors = useSensors(
    useSensor(MouseSensor, pointerOptions),
    useSensor(TouchSensor, touchOptions),
  );
  return (
    <DragHostContext value={handlers}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisions}
        accessibility={{ container: document.body }}
        onDragStart={({ active }) =>
          setDragging({ label: active.data.current?.label ?? "" })
        }
        onDragCancel={() => {
          setDragging(undefined);
          handlers.current?.cancel();
        }}
        onDragEnd={(event) => {
          setDragging(undefined);
          handlers.current?.end(event);
        }}
      >
        {children}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className={styles.overlay}>
                <NavigationItem label={dragging.label} />
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </DragHostContext>
  );
}

/** The cards, or one section's list when `pageSection` names it. */
export function RailArrangement(props: Parameters<typeof Arrangement>[0]) {
  // Alone, an arrangement carries its own drags.
  return useContext(DragHostContext) ? (
    <Arrangement {...props} />
  ) : (
    <RailDrag>
      <Arrangement {...props} />
    </RailDrag>
  );
}

function Arrangement({
  partition,
  sections,
  renderEntry,
  renderSectionList,
  renderRowActions,
  isPinned,
  onTogglePin,
  pageSection,
  selectedSection,
  openSection,
  compact = false,
}: {
  partition: string;
  sections: Group[];
  renderEntry(entry: RailEntry, section?: string): ReactNode;
  renderSectionList?:
    | ((
        id: string,
        title: string,
        entries: readonly RailEntry[],
        action: ReactNode,
      ) => ReactNode)
    | undefined;
  renderRowActions?:
    | ((entry: RailEntry, close: () => void, focus: () => void) => ReactNode)
    | undefined;
  isPinned(entry: RailEntry): boolean;
  onTogglePin(entry: RailEntry, pinned: boolean): void;
  pageSection?: string | undefined;
  selectedSection?: string | undefined;
  openSection(id: string): void;
  compact?: boolean;
}) {
  const host = useContext(DragHostContext);
  const { active } = useDndContext();
  const { layout, move, reorder, create, rename, remove, reset } =
    useRailLayout(partition);
  const reducedMotion = useReducedMotion();
  const animateDrop = useRef(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<{
    entry?: RailEntry;
    from?: string | undefined;
  }>();
  const newSectionButton = useRef<HTMLButtonElement>(null);
  const groups: Group[] = [
    ...sections,
    ...layout.sections.map((section) => ({
      ...section,
      content: <RailGroup id={section.id} title={section.title} />,
    })),
  ];
  const order = [...layout.order, ...groups.map((group) => group.id)];
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const saved = (ok: boolean) => {
    setError(ok ? "" : "Couldn’t save the sidebar on this device. Try again.");
    return ok;
  };
  const value: Arrangement = {
    pageSection,
    renderSectionList,
    selectedSection,
    openSection,
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
    })),
    placements: layout.placements,
    membership: railSections(
      layout,
      groups.map(({ id, title }) => ({ id, title })),
    ),
    move: (entry, section, from) => {
      // A conversation lives in Team or Solo: nothing moves or copies it there.
      if (entry.kind === "page" || holdsCopy(entry, section))
        saved(move(entry, section, from));
    },
    unplace: (entry, section) => {
      saved(reset(entry.id, section));
    },
    reorder: (id, over) => {
      saved(
        reorder(
          id,
          over,
          groups.map((group) => group.id),
        ),
      );
    },
    create: (entry, from) => setCreating({ entry, from }),
    rename: (id, title) => {
      saved(rename(id, title));
    },
    remove: (id) => {
      saved(remove(id));
    },
    renderEntry,
    renderRowActions,
    isPinned,
    onTogglePin,
  };
  // The cards answer drops, wherever the row came from.
  const end = ({ active, over }: DragEndEvent) => {
    const data = active.data.current;
    animateDrop.current =
      !!over &&
      !reducedMotion &&
      (data?.section
        ? data.section !== over.id
        : !!data?.entry &&
          over.id !== data.source &&
          over.id !== "rail:new-section");
    if (!over) return;
    if (data?.section)
      value.reorder(
        data.section,
        over.id === "rail:top"
          ? (groups[0]?.id ?? data.section)
          : String(over.id),
      );
    else if (data?.entry) {
      // Only a row in a section a person made moves; the rest copy.
      const from = data.movable ? data.source : undefined;
      if (over.id === "rail:new-section")
        setCreating({ entry: data.entry, from });
      else if (over.id !== data.source)
        value.move(data.entry, String(over.id), from);
    }
  };
  const latestEnd = useRef(end);
  useLayoutEffect(() => {
    latestEnd.current = end;
  });
  useLayoutEffect(() => {
    if (!host || pageSection) return;
    const handlers: DragHandlers = {
      end: (event) => latestEnd.current(event),
      cancel: () => {
        animateDrop.current = false;
      },
    };
    host.current = handlers;
    return () => {
      if (host.current === handlers) host.current = undefined;
    };
  }, [host, pageSection]);
  return (
    <ArrangementContext value={value}>
      <ListedContext value={!!pageSection}>
        {pageSection ? (
          (groups.find((group) => group.id === pageSection)?.content ?? (
            <EmptyState
              icon={<ChatCircleIcon />}
              title="Section unavailable"
              description="This sidebar section may have been removed."
            />
          ))
        ) : (
          <>
            {compact && (
              <section className={styles.dock} aria-label="Sidebar sections">
                {groups.map((group) => (
                  <div key={group.id} className={styles.dockTile}>
                    <Tooltip content={group.title} hint="dock" side="right">
                      <IconButton
                        size="large"
                        variant={
                          selectedSection === group.id ? "prominent" : "subtle"
                        }
                        aria-label={group.title}
                        aria-current={
                          selectedSection === group.id ? "page" : undefined
                        }
                        data-selected={
                          selectedSection === group.id || undefined
                        }
                        icon={group.icon ?? <SquaresFourIcon size={22} />}
                        onClick={() => openSection(group.id)}
                      />
                    </Tooltip>
                  </div>
                ))}
              </section>
            )}
            <div hidden={compact}>
              <div
                className={styles.groups}
                onKeyDownCapture={(event) => {
                  // Escape belongs to the active move before the shell's rail dismissal.
                  if (active && event.key === "Escape") event.preventDefault();
                }}
              >
                <FirstSectionTarget />
                {groups.map((group) => (
                  <motion.div
                    key={group.id}
                    layout="position"
                    layoutDependency={layout}
                    initial={false}
                    transition={{
                      layout: animateDrop.current
                        ? { type: "spring", duration: 0.28, bounce: 0.15 }
                        : { duration: 0 },
                    }}
                    onLayoutAnimationComplete={() => {
                      animateDrop.current = false;
                    }}
                  >
                    {group.content}
                  </motion.div>
                ))}
              </div>
              <div className={styles.createSection}>
                <Button
                  ref={newSectionButton}
                  size="sm"
                  variant="subtle"
                  onClick={() => setCreating({})}
                >
                  New section
                </Button>
              </div>
              <NewSectionTarget />
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-caption text-secondary">
            {error}
          </p>
        )}
        {creating && (
          <CreateSidebarSection
            channelName={creating.entry?.label}
            finalFocus={creating.entry ? false : newSectionButton}
            writable
            refreshing={false}
            retry={async () => {}}
            close={() => setCreating(undefined)}
            create={({ id, name }) => {
              if (
                !saved(
                  create(
                    id,
                    name,
                    creating.entry,
                    groups.map((group) => group.id),
                    creating.from,
                  ),
                )
              )
                throw new Error("Couldn’t save this section. Try again.");
              setCreating(undefined);
              return true;
            }}
          />
        )}
      </ListedContext>
    </ArrangementContext>
  );
}

/** Shared section/row paint stays with NavigationSection and NavigationItem. */
export function RailGroup({
  id,
  title,
  action,
  children,
  rows: sourceRows = [],
  footer,
  rowsLabel,
  unlimited = false,
  avatarGrid = id === "pins",
  leadingEntryIds = [],
  views,
  trailingEntryId,
  sortEntries,
  pageContent,
  renderOpen,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
  rows?: readonly { entry: RailEntry; content: ReactNode }[];
  footer?: ReactNode;
  rowsLabel?: string;
  unlimited?: boolean;
  avatarGrid?: boolean;
  leadingEntryIds?: readonly string[];
  /** Rows that open this section's views, under its leading entries. */
  views?: ReactNode;
  trailingEntryId?: string;
  sortEntries?: (a: RailEntry, b: RailEntry) => number;
  pageContent?: ReactNode;
  renderOpen?: (hidden: readonly RailEntry[], open: () => void) => ReactNode;
}) {
  const arrangement = useContext(ArrangementContext);
  // A section's page shares the cards' drag context: only the card is a
  // target or moves.
  const listed = useContext(ListedContext);
  const { active } = useDndContext();
  const drop = useDroppable({
    id: listed ? `listed:${id}` : id,
    disabled: listed,
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  const drag = useDraggable({
    id: listed ? `listed:section:${id}` : `section:${id}`,
    disabled: listed,
    data: { section: id, label: title },
  });
  const grabber = useRef<HTMLSpanElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const custom = id.startsWith("custom:");
  // Only a section a person made has a name of their own to change, in place.
  const [naming, setNaming] = useState(false);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (naming || !refocus.current) return;
    refocus.current = false;
    titleButton.current?.focus();
  }, [naming]);
  const named = (name?: string) => {
    if (!naming) return;
    // Enter and Escape return to the title; leaving keeps focus where it went.
    refocus.current = nameField.current === document.activeElement;
    setNaming(false);
    const next = name?.trim();
    if (next && next !== title) arrangement?.rename(id, next);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const movableGroups = arrangement?.groups ?? [];
  const index = movableGroups.findIndex((group) => group.id === id);
  const sectionDrag = !!active?.data.current?.section;
  const target = drop.isOver && active?.data.current?.section !== id;
  const sourceIndex = movableGroups.findIndex(
    (group) => group.id === active?.data.current?.section,
  );
  const insertionEdge =
    target && sectionDrag && sourceIndex >= 0 && index >= 0
      ? sourceIndex < index
        ? "after"
        : "before"
      : undefined;
  const sourceById = new Map(sourceRows.map((row) => [row.entry.id, row]));
  const entries =
    arrangement?.membership.entries(
      id,
      sourceRows.map((row) => row.entry),
    ) ?? sourceRows.map((row) => row.entry);
  const rows = entries.map((entry) => (
    <RailSourceRow key={entry.id} section={id} entry={entry}>
      {sourceById.get(entry.id)?.content ?? arrangement?.renderEntry(entry, id)}
    </RailSourceRow>
  ));
  const notes = children;
  const placed =
    arrangement?.placements.filter((item) => item.section === id) ?? [];
  if (sortEntries)
    rows.sort((a, b) => sortEntries(a.props.entry, b.props.entry));
  if (trailingEntryId)
    rows.sort(
      (a, b) =>
        Number(a.props.entry.id === trailingEntryId) -
        Number(b.props.entry.id === trailingEntryId),
    );
  const limited = id !== "pins" && !unlimited;
  const leading = leadingEntryIds.flatMap((entryId) =>
    rows.filter((row) => row.props.entry.id === entryId),
  );
  const preview = rows.filter(
    (row) => !leadingEntryIds.includes(row.props.entry.id),
  );
  const shown = limited ? preview.slice(0, 4) : preview;
  const more = limited && preview.length > 4 && (!footer || placed.length > 0);
  if (arrangement?.pageSection === id && pageContent) return pageContent;
  if (
    arrangement?.pageSection === id &&
    arrangement.renderSectionList &&
    (id === "pins" || id === "agents" || id.startsWith("custom:"))
  )
    return arrangement.renderSectionList(
      id,
      title,
      rows.map((row) => row.props.entry),
      action,
    );
  if (arrangement?.pageSection === id)
    return (
      <section className={feedStyles.page} aria-label={title}>
        <Header title={title} actions={action} />
        <div className={`${feedStyles.scroll} ${styles.pageRows}`}>
          {rows.map((row) => (
            <div key={row.key} className={styles.pageRow}>
              {row}
            </div>
          ))}
          {notes}
        </div>
      </section>
    );
  const card = (
    <div
      ref={(node) => {
        drop.setNodeRef(node);
        drag.setNodeRef(node);
      }}
      className={styles.group}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse" || !grabber.current) return;
        const bounds = grabber.current.getBoundingClientRect();
        const distance = Math.hypot(
          Math.max(
            bounds.left - event.clientX,
            0,
            event.clientX - bounds.right,
          ),
          Math.max(
            bounds.top - event.clientY,
            0,
            event.clientY - bounds.bottom,
          ),
        );
        // Brighten within one handle width without rerendering the rail on movement.
        const opacity = Math.max(0, 1 - distance / bounds.width);
        event.currentTarget.style.setProperty(
          "--rail-grabber-proximity",
          String(opacity),
        );
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.removeProperty("--rail-grabber-proximity");
      }}
      data-rail-section={id}
      data-drop-target={target || undefined}
      data-section-drag={sectionDrag || undefined}
      data-insertion-edge={insertionEdge}
      data-dragging={drag.isDragging || undefined}
    >
      <span ref={grabber} className={styles.grabber}>
        <IconButton
          ref={drag.setActivatorNodeRef}
          {...drag.listeners}
          aria-label={`Move ${title} section`}
          icon={
            <GripHorizontalIcon
              size={24}
              strokeWidth={2}
              fill="currentColor"
              className={`${styles.grabDots} text-subtle`}
            />
          }
          aria-keyshortcuts="ArrowUp ArrowDown"
          aria-description="Use the Up and Down arrow keys to move this section."
          onKeyDown={(event) => {
            const offset =
              event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!offset) return;
            event.preventDefault();
            const neighbor = movableGroups[index + offset];
            if (neighbor) arrangement?.reorder(id, neighbor.id);
          }}
        />
      </span>
      <NavigationSection
        label={
          naming ? (
            <Input
              ref={nameField}
              controlSize="sm"
              aria-label="Section name"
              defaultValue={title}
              maxLength={256}
              autoFocus
              // The field keeps its own text menu rather than the section's.
              onContextMenu={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => named(event.currentTarget.value)}
              onKeyDown={(event) => {
                // WebKit's IME commit Enter arrives after composition ends.
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (event.key === "Enter") named(event.currentTarget.value);
                else if (event.key === "Escape") {
                  // Cancel the name, not the rail.
                  event.stopPropagation();
                  named();
                } else return;
                event.preventDefault();
              }}
            />
          ) : (
            <Button
              ref={titleButton}
              variant="plain"
              size="text"
              onClick={() => arrangement?.openSection(id)}
              onDoubleClick={custom ? () => setNaming(true) : undefined}
            >
              {title}
            </Button>
          )
        }
        action={action && <span data-rail-card-actions="">{action}</span>}
      >
        {leading}
        {views}
        {rowsLabel ? (
          <ul aria-label={rowsLabel} className={styles.rows}>
            {shown.map((row) => (
              <li key={row.key}>{row}</li>
            ))}
          </ul>
        ) : avatarGrid ? (
          <div
            className={styles.avatarGrid}
            data-pins-grid={id === "pins" ? "" : undefined}
          >
            {shown}
          </div>
        ) : (
          shown
        )}
        {notes}
        {(more || footer) && renderOpen ? (
          renderOpen(
            preview.slice(shown.length).map((row) => row.props.entry),
            () => arrangement?.openSection(id),
          )
        ) : more ? (
          <NavigationItem
            label={`Open ${title}`}
            data-rail-view-more=""
            aria-label={`Open ${title}`}
            icon={<ArrowRightIcon size={18} />}
            onClick={() => arrangement?.openSection(id)}
          />
        ) : (
          footer
        )}
      </NavigationSection>
    </div>
  );
  return custom ? (
    <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        onContextMenu={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
            setMenuOpen(true);
          }
        }}
      >
        {card}
      </ContextMenuTrigger>
      <MenuPopup
        anchor={menuAnchor}
        // Rename hands focus to the name field, not back to the card.
        finalFocus={() => nameField.current ?? true}
      >
        <MenuItem onClick={() => setNaming(true)}>
          <MenuIcon>
            <PencilSimpleIcon size={14} />
          </MenuIcon>
          Rename section
        </MenuItem>
        <MenuItem onClick={() => arrangement?.remove(id)}>
          <MenuIcon>
            <TrashIcon size={14} />
          </MenuIcon>
          Remove section
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  ) : (
    card
  );
}

/** Agents retain their inventory entry; other rows move to their chosen section. */
export function RailSourceRow({
  entry,
  section,
  children,
}: {
  entry: RailEntry;
  section: string;
  children: ReactNode;
}) {
  const arrangement = useContext(ArrangementContext);
  if (
    section !== "agents" &&
    arrangement?.membership.assigned.has(entry.id) &&
    arrangement.membership.assigned.get(entry.id) !== section
  )
    return null;
  return (
    <RailDestinationRow entry={entry} section={section}>
      {children}
    </RailDestinationRow>
  );
}
export function RailDestinationRow({
  entry,
  section,
  children,
}: {
  entry: RailEntry;
  section: string;
  children: ReactNode;
}) {
  // The arrangement changes with every sidebar update. A row reads only what
  // it shows; its menu reads the rest while open.
  const listed = useContext(ListedContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const drag = useDraggable({
    // A conversation can sit in a card and in the open list at once.
    id: `row:${listed ? "list:" : ""}${section}:${entry.id}`,
    data: {
      entry,
      source: section,
      label: entry.label,
      movable: !listed && ownSection(section),
    },
  });
  return (
    <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
            setMenuOpen(true);
          }
        }}
        render={
          <div
            ref={drag.setNodeRef}
            {...drag.listeners}
            className={styles.row}
            data-rail-row={entry.id}
            data-dragging={drag.isDragging || undefined}
          />
        }
      >
        {children}
      </ContextMenuTrigger>
      <MenuPopup anchor={menuAnchor}>
        <RowMenu
          entry={entry}
          section={section}
          listed={listed}
          close={() => setMenuOpen(false)}
          focus={() =>
            drag.node.current?.querySelector<HTMLElement>("button")?.focus()
          }
        />
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function RowMenu({
  entry,
  section,
  listed,
  close,
  focus,
}: {
  entry: RailEntry;
  section: string;
  listed: boolean;
  close(): void;
  focus(): void;
}) {
  const arrangement = useContext(ArrangementContext);
  const pinned = section === "pins" || arrangement?.isPinned(entry);
  const page = entry.kind === "page";
  // A conversation stays in Team or Solo: sections a person made hold copies.
  // Only its row in such a section, in the sidebar, moves on to another.
  const own = !page && ownSection(section);
  const from = own && !listed ? section : undefined;
  const label = page
    ? "Move page"
    : from
      ? "Move to section"
      : "Add to section";
  return (
    <>
      <MenuSubmenu>
        <MenuSubmenuTrigger>
          <MenuIcon>
            <FolderSimpleIcon size={14} />
          </MenuIcon>
          {label}
        </MenuSubmenuTrigger>
        <MenuSubmenuPopup aria-label={`${label}: ${entry.label}`}>
          {arrangement?.groups
            .filter((group) => page || ownSection(group.id))
            .map((group) => (
              <MenuItem
                key={group.id}
                disabled={group.id === section}
                onClick={() => arrangement.move(entry, group.id, from)}
              >
                {group.title}
              </MenuItem>
            ))}
          {(page ||
            arrangement?.groups.some((group) => ownSection(group.id))) && (
            <MenuSeparator />
          )}
          <MenuItem onClick={() => arrangement?.create(entry, from)}>
            New section…
          </MenuItem>
        </MenuSubmenuPopup>
      </MenuSubmenu>
      {own && (
        <MenuItem onClick={() => arrangement?.unplace(entry, section)}>
          <MenuIcon>
            <MinusIcon size={14} />
          </MenuIcon>
          Remove from section
        </MenuItem>
      )}
      <MenuItem onClick={() => arrangement?.onTogglePin(entry, !pinned)}>
        <MenuIcon>
          <PinIcon size={14} />
        </MenuIcon>
        {pinned ? "Unpin" : "Pin"}
      </MenuItem>
      {arrangement?.renderRowActions?.(entry, close, focus)}
    </>
  );
}
function FirstSectionTarget() {
  const { active } = useDndContext();
  const { setNodeRef, isOver } = useDroppable({
    id: "rail:top",
    disabled: !active?.data.current?.section,
  });
  return (
    <div
      ref={setNodeRef}
      className={styles.firstSectionTarget}
      data-drop-target={isOver || undefined}
      aria-hidden="true"
    />
  );
}

function NewSectionTarget() {
  const { active } = useDndContext();
  const shown = !!active && !active.data.current?.section;
  const { setNodeRef, isOver } = useDroppable({
    id: "rail:new-section",
    disabled: !shown,
  });
  const content = (
    <div
      ref={setNodeRef}
      className={styles.newSection}
      data-shown={shown || undefined}
      aria-hidden={!shown}
      inert={!shown}
    >
      <section
        className={styles.newSectionReveal}
        aria-label="New section"
        data-drop-target={isOver || undefined}
      >
        <div className={styles.newSectionLabel}>
          <PlusIcon size={16} aria-hidden="true" />
          <span>New section</span>
        </div>
      </section>
    </div>
  );
  const slot = document.getElementById("rail-drop-slot");
  return slot ? createPortal(content, slot) : content;
}
