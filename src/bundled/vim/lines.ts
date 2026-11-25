/*
 * Lines for walking items that have no arrow keys of their own: items whose
 * boxes overlap vertically share a line, such as a sidebar heading and its
 * trailing "More actions" button, or a row of cards.
 */
export type Box = Readonly<{ top: number; bottom: number; left: number }>;

/** Rounding and borders can make neighbouring lines touch by a pixel. */
const SLACK = 2;

export const sameLine = (a: Box, b: Box) =>
  a.top < b.bottom - SLACK && b.top < a.bottom - SLACK;

/**
 * Of `boxes` in document order, the index of the item on the nearest line
 * wholly below (or above) `from` that starts nearest its column, as Vim's
 * j and k keep the column; -1 when there is none.
 */
export function lineItem(boxes: readonly Box[], from: Box, down: boolean) {
  const beyond = (box: Box) =>
    down ? box.top >= from.bottom - SLACK : box.bottom <= from.top + SLACK;
  let nearest: Box | undefined;
  for (const box of boxes)
    if (
      beyond(box) &&
      (!nearest ||
        (down
          ? box.bottom <= nearest.top + SLACK
          : box.top >= nearest.bottom - SLACK))
    )
      nearest = box;
  let best = -1;
  boxes.forEach((box, index) => {
    if (!nearest || !beyond(box) || !sameLine(box, nearest)) return;
    const current = boxes[best];
    if (
      !current ||
      Math.abs(box.left - from.left) < Math.abs(current.left - from.left)
    )
      best = index;
  });
  return best;
}
