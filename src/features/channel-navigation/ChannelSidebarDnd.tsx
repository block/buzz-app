import {
  DndContext,
  DragOverlay,
  PointerSensor,
  type CollisionDetection,
  pointerWithin,
  useDndContext,
  useDraggable,
  useDndMonitor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SidebarSection } from "../../bundled/channels/SidebarSection";
import type { SidebarRowKind } from "../../bundled/channels/sidebar-sections";
import { NavigationSectionHeading } from "../../shared/design-system/ui/NavigationSection";
import { Panel } from "../../shared/design-system/ui/Panel";
import styles from "../../bundled/channels/Channels.module.css";

const Writable = createContext(false);

// Group gaps target the neighbour whose insertion edge lies in that same gap.
export const sidebarCollisions: CollisionDetection = (args) => {
  const domain = args.active.data.current?.groupDomain ?? "channels";
  if (!args.active.data.current?.group)
    return pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        ({ data }) =>
          (data.current?.groupDomain ?? "channels") === domain &&
          (!data.current?.accepts ||
            data.current.accepts.includes(args.active.data.current?.rowKind)),
      ),
    });
  const groups = args.droppableContainers
    .filter(
      ({ data }) =>
        data.current?.group &&
        (data.current?.groupDomain ?? "channels") === domain,
    )
    .sort((a, b) => a.data.current?.groupIndex - b.data.current?.groupIndex);
  const pointer = args.pointerCoordinates;
  const hit = pointerWithin({ ...args, droppableContainers: groups })[0];
  if (hit) {
    // Cards move by their headers, so the target's header decides the side:
    // above its middle lands before the card, anywhere below lands after it.
    // A drop reports the neighbour whose index puts the moved card on that
    // side. Without a measured header, the card's own middle stands in.
    const index = groups.findIndex(({ id }) => id === hit.id);
    const header: { top: number; height: number } | undefined =
      groups[index]?.data.current?.header?.();
    const rect = header?.height ? header : args.droppableRects.get(hit.id);
    const from = args.active.data.current.groupIndex;
    const to = groups[index]?.data.current?.groupIndex;
    if (!pointer || !rect || from === undefined || to === undefined)
      return [hit];
    const above = pointer.y < rect.top + rect.height / 2;
    const neighbour =
      above && from < to
        ? groups[index - 1]
        : !above && from > to
          ? groups[index + 1]
          : groups[index];
    return [{ id: (neighbour ?? groups[index])?.id ?? hit.id }];
  }
  if (!pointer) return [];
  for (let index = 1; index < groups.length; index++) {
    const above = groups[index - 1];
    const below = groups[index];
    if (!above || !below) continue;
    const top = args.droppableRects.get(above.id);
    const bottom = args.droppableRects.get(below.id);
    if (
      top &&
      bottom &&
      pointer.y > top.bottom &&
      pointer.y < bottom.top &&
      pointer.x >= Math.max(top.left, bottom.left) &&
      pointer.x <= Math.min(top.right, bottom.right)
    ) {
      const target =
        args.active.data.current.groupIndex < below.data.current?.groupIndex
          ? above
          : below;
      return [{ id: target.id }];
    }
  }
  return [];
};

// A click must still select the row; only a deliberate pull starts a move.
// useSensor memoizes on this object, so an inline literal would rebuild the
// sensors, and re-render every draggable row, on each sidebar render.
const pointerSensorOptions = { activationConstraint: { distance: 6 } };

/**
 * Pointer moves between sidebar sections (Messages groups, Starred and Channels,
 * or Solo projects and Chats), and reorders saved groups by their header. A drop
 * only reports its destination, so the caller saves it exactly like the menus'
 * moves; those menus remain the keyboard path.
 */
export function ChannelSidebarDnd({
  writable,
  onMove,
  onReorder,
  overlay,
  children,
}: {
  writable: boolean;
  onMove: (channelId: string, sectionKey: string) => void;
  onReorder: (sectionKey: string, overKey: string) => void;
  overlay: (id: string, group: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<{ id: string; group: boolean }>();
  const sensors = useSensors(useSensor(PointerSensor, pointerSensorOptions));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollisions}
      // Open cards can run past the edge: start early and move fast.
      autoScroll={{ threshold: { x: 0, y: 0.15 }, acceleration: 20 }}
      // The sidebar's own status is its loading notice; drag announcements live outside it.
      accessibility={{ container: document.body }}
      onDragStart={({ active }) =>
        setDragging({
          id: String(active.id),
          group: !!active.data.current?.group,
        })
      }
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={({ active, over }) => {
        setDragging(undefined);
        if (!over) return;
        if (active.data.current?.group) {
          if (over.id !== active.id)
            onReorder(String(active.id), String(over.id));
        } else if (over.id !== active.data.current?.sectionKey)
          onMove(String(active.id), String(over.id));
      }}
    >
      <Writable.Provider value={writable}>{children}</Writable.Provider>
      <CollapsedDragAnchor />
      <CardDropLine />
      {createPortal(
        // The optimistic move relocates the row, so nothing remains to settle back onto.
        <DragOverlay dropAnimation={null}>
          {dragging?.group ? (
            <CardDragHeader>{overlay(dragging.id, true)}</CardDragHeader>
          ) : dragging ? (
            overlay(dragging.id, false)
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** The scrolling ancestor that holds the sidebar's cards. */
function scroller(node: HTMLElement) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return undefined;
}

const headerOf = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-sidebar-section="${CSS.escape(id)}"] summary`,
  );

/**
 * Cards keep their size while one is dragged. If anything does shift when the
 * drag starts, the grabbed header stays where it was under the pointer and
 * the drop targets re-measure. A cancelled
 * drag restores the scroll position; a drop keeps the moved card in view.
 */
function CollapsedDragAnchor() {
  const { active, measureDroppableContainers } = useDndContext();
  const id = active?.data.current?.group ? String(active.id) : undefined;
  const start = useRef<{
    top: number;
    scrollTop: number;
    id: string;
    pinned?: true;
  }>(undefined);
  const cancelled = useRef(false);
  useDndMonitor({
    onDragStart: ({ active }) => {
      cancelled.current = false;
      const header = active.data.current?.group
        ? headerOf(String(active.id))
        : null;
      const list = header && scroller(header);
      start.current =
        header && list
          ? {
              id: String(active.id),
              top: header.getBoundingClientRect().top,
              scrollTop: list.scrollTop,
            }
          : undefined;
    },
    onDragCancel: () => {
      cancelled.current = true;
    },
  });
  useLayoutEffect(() => {
    const saved = start.current;
    if (!saved) return;
    const header = headerOf(saved.id);
    const list = header && scroller(header);
    if (!header || !list) return;
    if (id) {
      // Pin once; afterwards auto-scroll owns the position.
      if (saved.pinned) return;
      saved.pinned = true;
      list.scrollTop += header.getBoundingClientRect().top - saved.top;
      measureDroppableContainers([]);
      return;
    }
    start.current = undefined;
    if (cancelled.current) list.scrollTop = saved.scrollTop;
    // The saved order may render a frame later; reveal the moved card then.
    else
      requestAnimationFrame(() =>
        headerOf(saved.id)?.scrollIntoView({ block: "nearest" }),
      );
  }, [id, measureDroppableContainers]);
  return null;
}

/**
 * What follows the pointer while a card moves: its header alone, drawn as a
 * collapsed card. The card itself stays where it was, full size and faded.
 */
function CardDragHeader({ children }: { children: ReactNode }) {
  return (
    <div className={styles.cardDragOverlay}>
      <Panel as="div">
        <div className={styles.cardDragHeader}>
          <NavigationSectionHeading disclosure>
            <details>
              <summary tabIndex={-1}>
                <span className={styles.sectionLabel}>{children}</span>
              </summary>
            </details>
          </NavigationSectionHeading>
        </div>
      </Panel>
    </div>
  );
}

/** How far an element's CSS translate moves it down right now. */
function shiftOf(element: HTMLElement) {
  const [, y] = getComputedStyle(element).translate.split(" ");
  return y ? Number.parseFloat(y) || 0 : 0;
}

/**
 * Where a moved card will land, between cards. The cards below the landing
 * gap slide down a little to give the line room, and the line sits in the
 * measured middle of that gap whatever spaces the cards apart, so it is even
 * above and below whichever way the card is moving.
 */
function CardDropLine() {
  const { active, over } = useDndContext();
  const from = active?.data.current?.group
    ? active.data.current.groupIndex
    : undefined;
  const to = over?.data.current?.groupIndex;
  const target =
    from !== undefined && to !== undefined && over && over.id !== active?.id
      ? String(over.id)
      : undefined;
  const before = target !== undefined && from > to;
  const line = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = line.current;
    const card = target
      ? document.querySelector<HTMLElement>(
          `[data-sidebar-section="${CSS.escape(target)}"]`,
        )
      : null;
    const cards = card?.closest("[data-sidebar-cards]");
    const list = card && scroller(card);
    if (!node || !card || !cards || !list) return;
    // The cards beside the target: top-level cards, or the workspaces a Solo
    // region composes inside its own card.
    const region =
      card.parentElement?.closest("[data-sidebar-section]") ?? null;
    const shown = [
      ...cards.querySelectorAll<HTMLElement>("[data-sidebar-section]"),
    ].filter(
      (element) =>
        element.getClientRects().length > 0 &&
        (element.parentElement?.closest("[data-sidebar-section]") ?? null) ===
          region,
    );
    const index = shown.indexOf(card) + (before ? 0 : 1);
    const [upper, lower] = [shown[index - 1], shown[index]];
    const moved = shown.slice(index);
    for (const element of moved) element.setAttribute("data-drop-shift", "");
    card.setAttribute("data-drop-line", "");
    let request = 0;
    const place = () => {
      const box = card.getBoundingClientRect();
      const room = node.offsetHeight;
      const lowerTop = lower?.getBoundingClientRect().top;
      const top = upper?.getBoundingClientRect().bottom;
      // Between two cards, the middle of their gap; at either end of the
      // list, the middle of the room the slide opens.
      const middle =
        top !== undefined && lowerTop !== undefined
          ? (top + lowerTop) / 2
          : top !== undefined
            ? top + room / 2
            : lower && lowerTop !== undefined
              ? lowerTop - shiftOf(lower) / 2
              : undefined;
      const view = list.getBoundingClientRect();
      if (middle === undefined || middle < view.top || middle > view.bottom)
        node.style.visibility = "hidden";
      else {
        node.style.visibility = "";
        node.style.top = `${middle - room / 2}px`;
        node.style.left = `${box.left}px`;
        node.style.width = `${box.width}px`;
      }
      request = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(request);
      for (const element of moved) element.removeAttribute("data-drop-shift");
      card.removeAttribute("data-drop-line");
    };
  }, [target, before]);
  return target
    ? createPortal(
        <div ref={line} className={styles.cardDropLine} aria-hidden="true" />,
        document.body,
      )
    : null;
}

/**
 * Frames only a channel's select surface, so its sessions never start a move.
 * The frame stays mounted while placement is read-only: the row keeps its
 * focus and open menu when a save starts or settles.
 */
export function DraggableChannel({
  channelId,
  sectionKey,
  rowKind = "channel",
  children,
}: {
  channelId: string;
  sectionKey: string;
  rowKind?: SidebarRowKind;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: channelId,
    data: { sectionKey, groupDomain: "channels", rowKind },
    disabled: !useContext(Writable),
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-channel-dragging={isDragging || undefined}
    >
      {children}
    </div>
  );
}

/** Shared header drag and post-drag click suppression for Team and Solo. */
export function useSidebarSectionDrag({
  sectionKey,
  reorderable,
  groupIndex,
  groupDomain = "channels",
  capturePointerDown = false,
}: {
  sectionKey: string;
  reorderable: boolean;
  groupIndex: number;
  groupDomain?: string;
  capturePointerDown?: boolean;
}) {
  const drag = useDraggable({
    id: sectionKey,
    data: { group: true, groupIndex, groupDomain },
    disabled: !reorderable,
  });
  const suppressClick = useRef(false);
  const handle = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!reorderable) return;
    const document = handle.current?.ownerDocument;
    if (!document) return;
    const suppressDragClick = (event: MouseEvent) => {
      if (
        !suppressClick.current ||
        event.detail === 0 ||
        !(event.target instanceof Node) ||
        !handle.current?.contains(event.target)
      )
        return;
      // dnd-kit stops clicks at document capture before React can cancel the
      // native summary toggle. Cancel there too, including its cleanup window.
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", suppressDragClick, true);
    return () => document.removeEventListener("click", suppressDragClick, true);
  }, [reorderable]);
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === sectionKey) suppressClick.current = true;
    },
  });
  return {
    isDragging: drag.isDragging,
    handle: reorderable
      ? {
          ref: (node: HTMLElement | null) => {
            handle.current = node;
            drag.setNodeRef(node);
          },
          listeners: {
            ...drag.listeners,
            ...(capturePointerDown
              ? {
                  // A contributed leading control stops drag activation.
                  onPointerDownCapture: () => {
                    suppressClick.current = false;
                  },
                }
              : {
                  onPointerDown: (event: PointerEvent<HTMLElement>) => {
                    suppressClick.current = false;
                    drag.listeners?.onPointerDown?.(event);
                  },
                }),
          },
        }
      : undefined,
  };
}

/** A reorderable saved group drags by its header, never its rows or actions. */
export function DroppableSidebarSection({
  disabled,
  reorderable,
  groupIndex,
  groupDomain = "channels",
  accepts,
  ...section
}: ComponentProps<typeof SidebarSection> & {
  disabled: boolean;
  reorderable: boolean;
  groupIndex: number;
  groupDomain?: string;
  /** Row kinds a drop may place here; every row when omitted. */
  accepts?: readonly SidebarRowKind[];
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: section.sectionKey,
    data: {
      group: reorderable,
      groupIndex,
      groupDomain,
      accepts,
      header: () => headerOf(section.sectionKey)?.getBoundingClientRect(),
    },
    disabled,
    // dnd-kit queues a re-measure of only the droppable that resized and clears
    // that queue after each render, losing ids queued in between: a section
    // resized mid-drag (text size) could keep a stale drop target. An empty list
    // keeps dnd-kit's drag-start queue: any section's resize re-measures every
    // enabled droppable.
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  const drag = useSidebarSectionDrag({
    sectionKey: section.sectionKey,
    reorderable,
    groupIndex,
    groupDomain,
  });
  const group = !!active?.data.current?.group;
  const from = active?.data.current?.groupIndex;
  return (
    <SidebarSection
      {...section}
      dropRef={setNodeRef}
      dropTarget={
        !group &&
        isOver &&
        active?.data.current?.sectionKey !== section.sectionKey
      }
      dropEdge={
        group && isOver && active?.id !== section.sectionKey
          ? from !== undefined && from < groupIndex
            ? "after"
            : "before"
          : undefined
      }
      dragHandle={drag.handle}
      dragging={drag.isDragging}
    />
  );
}
