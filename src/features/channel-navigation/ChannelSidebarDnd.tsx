import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SidebarSection } from "../../bundled/channels/SidebarSection";

const Writable = createContext(false);

/**
 * Pointer moves between saved groups, Starred and Channels, and reorders saved
 * groups by their header. A drop only reports its destination, so the caller
 * saves it exactly like the menus' moves; those menus remain the keyboard path.
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
  const sensors = useSensors(
    // A click must still select the row; only a deliberate pull starts a move.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      // A group lands only among saved groups; channels keep their targets.
      collisionDetection={(args) => {
        if (!args.active.data.current?.group) return pointerWithin(args);
        const groups = {
          ...args,
          droppableContainers: args.droppableContainers.filter(({ id }) =>
            String(id).startsWith("group:"),
          ),
        };
        const hits = pointerWithin(groups);
        if (hits.length) return hits;
        const rects = groups.droppableContainers.flatMap(({ id }) => {
          const rect = args.droppableRects.get(id);
          return rect ? [rect] : [];
        });
        const pointer = args.pointerCoordinates;
        // Fill only the saved-group gaps, never adjacent built-ins or panes.
        if (
          !pointer ||
          !rects.length ||
          pointer.x < Math.min(...rects.map((rect) => rect.left)) ||
          pointer.x > Math.max(...rects.map((rect) => rect.right)) ||
          pointer.y < Math.min(...rects.map((rect) => rect.top)) ||
          pointer.y > Math.max(...rects.map((rect) => rect.bottom))
        )
          return [];
        return closestCenter({
          ...groups,
          // The pointer identifies the gap, independent of header grab offset.
          collisionRect: {
            ...args.collisionRect,
            left: pointer.x,
            top: pointer.y,
            width: 0,
            height: 0,
          },
        });
      }}
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
      {createPortal(
        // The optimistic move relocates the row, so nothing remains to settle back onto.
        <DragOverlay dropAnimation={null}>
          {dragging ? overlay(dragging.id, dragging.group) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/**
 * Frames only a channel's select surface, so its sessions never start a move.
 * The frame stays mounted while placement is read-only: the row keeps its
 * focus and open menu when a save starts or settles.
 */
export function DraggableChannel({
  channelId,
  sectionKey,
  children,
}: {
  channelId: string;
  sectionKey: string;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: channelId,
    data: { sectionKey },
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

/** A reorderable saved group drags by its header, never its rows or actions. */
export function DroppableSidebarSection({
  disabled,
  reorderable,
  groupIndex,
  ...section
}: ComponentProps<typeof SidebarSection> & {
  disabled: boolean;
  reorderable: boolean;
  groupIndex: number;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: section.sectionKey,
    disabled,
  });
  const drag = useDraggable({
    id: section.sectionKey,
    data: { group: true, groupIndex },
    disabled: !reorderable,
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
      dragHandle={
        reorderable
          ? { ref: drag.setNodeRef, listeners: drag.listeners }
          : undefined
      }
      dragging={drag.isDragging}
    />
  );
}
