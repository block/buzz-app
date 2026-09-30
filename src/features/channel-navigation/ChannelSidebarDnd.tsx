import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SidebarSection } from "../../bundled/channels/SidebarSection";

/**
 * Pointer moves between saved groups and Channels. A drop only reports its
 * destination, so the caller saves it exactly like the row menu's move; that
 * menu remains the keyboard path.
 */
export function ChannelSidebarDnd({
  onMove,
  overlay,
  children,
}: {
  onMove: (channelId: string, sectionKey: string) => void;
  overlay: (channelId: string) => ReactNode;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<string>();
  const sensors = useSensors(
    // A click must still select the row; only a deliberate pull starts a move.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // The sidebar's own status is its loading notice; drag announcements live outside it.
      accessibility={{ container: document.body }}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={({ active, over }) => {
        setDragging(undefined);
        if (over && over.id !== active.data.current?.sectionKey)
          onMove(String(active.id), String(over.id));
      }}
    >
      {children}
      {createPortal(
        // The optimistic move relocates the row, so nothing remains to settle back onto.
        <DragOverlay dropAnimation={null}>
          {dragging ? overlay(dragging) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

export function DraggableChannel({
  channelId,
  sectionKey,
  disabled,
  children,
}: {
  channelId: string;
  sectionKey: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: channelId,
    data: { sectionKey },
    disabled,
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

export function DroppableSidebarSection({
  disabled,
  ...section
}: ComponentProps<typeof SidebarSection> & { disabled: boolean }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: section.sectionKey,
    disabled,
  });
  return (
    <SidebarSection
      {...section}
      dropRef={setNodeRef}
      dropTarget={
        isOver && active?.data.current?.sectionKey !== section.sectionKey
      }
    />
  );
}
