import type { CollisionDetection } from "@dnd-kit/core";
import { expect, it } from "vitest";
import { sidebarCollisions } from "./ChannelSidebarDnd";

type Args = Parameters<CollisionDetection>[0];

// Cards a, b (very tall), c, d stacked with 8px gaps.
const cards = [
  { id: "a", top: 0, height: 40 },
  { id: "b", top: 48, height: 600 },
  { id: "c", top: 656, height: 40 },
  { id: "d", top: 704, height: 40 },
];

function over(dragging: string, y: number, headerHeight?: number) {
  const droppableContainers = cards.map(({ id, top }, groupIndex) => ({
    id,
    data: {
      current: {
        group: true,
        groupIndex,
        ...(headerHeight
          ? { header: () => ({ top, height: headerHeight }) }
          : {}),
      },
    },
  }));
  const droppableRects = new Map(
    cards.map(({ id, top, height }) => [
      id,
      { top, height, bottom: top + height, left: 0, right: 200, width: 200 },
    ]),
  );
  const collisions = sidebarCollisions({
    active: {
      id: dragging,
      data: {
        current: {
          group: true,
          groupIndex: cards.findIndex(({ id }) => id === dragging),
        },
      },
    },
    droppableContainers,
    droppableRects,
    pointerCoordinates: { x: 100, y },
    collisionRect: { top: y, left: 100, width: 1, height: 1 },
  } as unknown as Args);
  return collisions[0]?.id;
}

it("drops on the side of a tall card nearest the pointer", () => {
  // Dragging d up: the lower half of b means after b (before c's neighbour).
  expect(over("d", 600)).toBe("c");
  // Upper half of b means before b.
  expect(over("d", 60)).toBe("b");
  // Dragging a down: the upper half of b means before b, which is no move.
  expect(over("a", 60)).toBe("a");
  // Lower half of b means after b.
  expect(over("a", 600)).toBe("b");
});

it("still targets the neighbour across the gap between cards", () => {
  expect(over("a", 652)).toBe("b");
  expect(over("d", 652)).toBe("c");
});

it("decides the side by the target's header, which a person drags by", () => {
  // b's header is 48–148 at large text: its lower part means after b, even
  // though that is above the middle of the tall card.
  expect(over("a", 130, 100)).toBe("b");
  expect(over("d", 130, 100)).toBe("c");
  // Its upper part means before b.
  expect(over("a", 60, 100)).toBe("a");
  expect(over("d", 60, 100)).toBe("b");
  // Anywhere in the card below its header lands after it.
  expect(over("d", 400, 100)).toBe("c");
});
