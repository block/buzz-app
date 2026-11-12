import type { ComponentProps, ReactNode } from "react";
import {
  orderSidebarGroups,
  reorderSavedSectionKeys,
} from "../../bundled/channels/sidebar-sections";
import type { SidebarSection } from "../../bundled/channels/SidebarSection";
import styles from "../../bundled/channels/Channels.module.css";
import {
  ChannelSidebarDnd,
  useReorderableSection,
  type ReorderableSectionFrame,
} from "./ChannelSidebarDnd";
import type { SidebarGroupPosition } from "./sidebar-sections-service";

/** What a group's header takes from the list so the person can move the group. */
export type SidebarGroupFrame = ReorderableSectionFrame &
  Pick<ComponentProps<typeof SidebarSection>, "move">;

export type SidebarGroup = {
  /** The section key shared by collapse state and the saved order. */
  key: string;
  title: string;
  /** Where the group starts until the person moves it. Built-in groups omit it. */
  position?: SidebarGroupPosition | undefined;
  render: (frame: SidebarGroupFrame) => ReactNode;
};

/** The top-level groups in the person's order, movable by drag or menu. */
export function SidebarGroupList({
  groups,
  savedOrder,
  onOrderChange,
  reorderable,
}: {
  groups: readonly SidebarGroup[];
  savedOrder: readonly string[];
  onOrderChange: (order: readonly string[]) => void;
  reorderable: boolean;
}) {
  const ordered = orderSidebarGroups(groups, savedOrder);
  const keys = ordered.map(({ key }) => key);
  const moveGroup = (key: string, overKey: string) => {
    const order = reorderSavedSectionKeys(keys, savedOrder, key, overKey);
    if (order) onOrderChange(order);
  };
  return (
    <ChannelSidebarDnd
      writable={reorderable}
      onReorder={moveGroup}
      overlay={(key) => {
        const title = ordered.find((group) => group.key === key)?.title;
        return title ? (
          <div className={styles.channelDragOverlay}>
            <span>{title}</span>
          </div>
        ) : null;
      }}
    >
      {ordered.map((group, index) => {
        const previousKey = keys[index - 1];
        const nextKey = keys[index + 1];
        return (
          <SidebarGroupSlot
            key={group.key}
            group={group}
            groupIndex={index}
            reorderable={reorderable && ordered.length > 1}
            moveUp={
              previousKey ? () => moveGroup(group.key, previousKey) : undefined
            }
            moveDown={nextKey ? () => moveGroup(group.key, nextKey) : undefined}
          />
        );
      })}
    </ChannelSidebarDnd>
  );
}

function SidebarGroupSlot({
  group,
  groupIndex,
  reorderable,
  moveUp,
  moveDown,
}: {
  group: SidebarGroup;
  groupIndex: number;
  reorderable: boolean;
  moveUp: (() => void) | undefined;
  moveDown: (() => void) | undefined;
}) {
  const frame = useReorderableSection({
    sectionKey: group.key,
    groupIndex,
    groupDomain: "groups",
    disabled: false,
    reorderable,
  });
  return group.render({
    ...frame,
    move: reorderable ? { up: moveUp, down: moveDown } : undefined,
  });
}
