export type Axis = "horizontal" | "vertical";
export type Edge = "left" | "right" | "top" | "bottom";
export type Group = { id: string; tabs: string[]; selected: string };
export type LayoutNode =
  | { type: "pane"; id: string }
  | {
      type: "split";
      id: string;
      axis: Axis;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
export type LayoutState = { root: LayoutNode; groups: Group[] };
export type Box = { x: number; y: number; width: number; height: number };
export type SplitBox = Box & {
  id: string;
  axis: Axis;
  ratio: number;
  minRatio: number;
  maxRatio: number;
};
const MIN_WIDTH = 120;
const MIN_HEIGHT = 100;

export function initialLayout(
  count: number,
  width = 736,
  gap = 8,
): LayoutState {
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new RangeError("Expected one to four panels");
  const names = ["One", "Two", "Three", "Four"].slice(0, count);
  const row = (ids: string[], extent: number): LayoutNode => {
    const first = ids[0];
    if (!first) throw new Error("Cannot lay out an empty row");
    return ids.length === 1
      ? { type: "pane", id: first }
      : {
          type: "split",
          id: `initial-${ids[0]}`,
          axis: "horizontal",
          ratio:
            (extent - gap * (ids.length - 1)) / ids.length / (extent - gap),
          first: { type: "pane", id: first },
          second: row(
            ids.slice(1),
            extent - gap - (extent - gap * (ids.length - 1)) / ids.length,
          ),
        };
  };
  return {
    root: row(names, width),
    groups: names.map((id) => ({ id, tabs: [id], selected: id })),
  };
}

export function minimumSize(
  node: LayoutNode,
  gap: number,
): { width: number; height: number } {
  if (node.type === "pane") return { width: MIN_WIDTH, height: MIN_HEIGHT };
  const a = minimumSize(node.first, gap),
    b = minimumSize(node.second, gap);
  return node.axis === "horizontal"
    ? { width: a.width + gap + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + gap + b.height };
}

/** Compute whole-tree geometry, including the minimum size of nested subtrees. */
export function measureLayout(root: LayoutNode, bounds: Box, gap: number) {
  const panes = new Map<string, Box>();
  const splits: SplitBox[] = [];
  const visit = (node: LayoutNode, box: Box) => {
    if (node.type === "pane") {
      panes.set(node.id, box);
      return;
    }
    const horizontal = node.axis === "horizontal";
    const available = Math.max(0, (horizontal ? box.width : box.height) - gap);
    const firstMin = minimumSize(node.first, gap),
      secondMin = minimumSize(node.second, gap);
    const a = horizontal ? firstMin.width : firstMin.height,
      b = horizontal ? secondMin.width : secondMin.height;
    // A smaller viewport retains the arrangement rather than dropping panes.
    // New drops are separately rejected if their complete result cannot fit.
    const minRatio = available >= a + b ? a / available : a / (a + b);
    const maxRatio = available >= a + b ? 1 - b / available : minRatio;
    const ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio));
    const size = available * ratio;
    splits.push({
      ...box,
      id: node.id,
      axis: node.axis,
      ratio,
      minRatio,
      maxRatio,
    });
    visit(node.first, {
      ...box,
      width: horizontal ? size : box.width,
      height: horizontal ? box.height : size,
    });
    visit(node.second, {
      x: horizontal ? box.x + size + gap : box.x,
      y: horizontal ? box.y : box.y + size + gap,
      width: horizontal ? available - size : box.width,
      height: horizontal ? box.height : available - size,
    });
  };
  visit(root, bounds);
  return { panes, splits };
}

function replace(
  node: LayoutNode,
  id: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") return node.id === id ? replacement : node;
  return {
    ...node,
    first: replace(node.first, id, replacement),
    second: replace(node.second, id, replacement),
  };
}
function remove(node: LayoutNode, id: string): LayoutNode | undefined {
  if (node.type === "pane") return node.id === id ? undefined : node;
  const a = remove(node.first, id),
    b = remove(node.second, id);
  return a && b ? { ...node, first: a, second: b } : (a ?? b);
}

export function resizeSplit(
  node: LayoutNode,
  id: string,
  ratio: number,
): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === id) return { ...node, ratio };
  return {
    ...node,
    first: resizeSplit(node.first, id, ratio),
    second: resizeSplit(node.second, id, ratio),
  };
}
export function swapPanes(
  node: LayoutNode,
  first: string,
  second: string,
): LayoutNode {
  if (node.type === "pane")
    return {
      ...node,
      id: node.id === first ? second : node.id === second ? first : node.id,
    };
  return {
    ...node,
    first: swapPanes(node.first, first, second),
    second: swapPanes(node.second, first, second),
  };
}

/** Immutable proposal: remove the source first, then split the destination. */
export function splitPane(
  state: LayoutState,
  sourceId: string,
  targetId: string,
  edge: Edge,
  tab?: string,
): LayoutState | undefined {
  const source = state.groups.find((g) => g.id === sourceId),
    target = state.groups.find((g) => g.id === targetId);
  if (!source || !target || (tab && !source.tabs.includes(tab))) return;
  const extracting = !!tab && source.tabs.length > 1;
  if (sourceId === targetId && !extracting) return;
  let root = state.root;
  let groups = state.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
  let movingId = sourceId;
  if (extracting && tab) {
    if (groups.length >= 4) return;
    // Reuse a tab's identity when safe, even after its original group disappeared.
    movingId = `pane-${tab}`;
    while (groups.some((g) => g.id === movingId)) movingId += "-split";
    groups = groups.map((g) =>
      g.id === sourceId
        ? {
            ...g,
            tabs: g.tabs.filter((t) => t !== tab),
            selected:
              g.selected === tab
                ? (g.tabs.find((t) => t !== tab) ?? "")
                : g.selected,
          }
        : g,
    );
    groups.push({ id: movingId, tabs: [tab], selected: tab });
  } else {
    const remaining = remove(root, sourceId);
    if (!remaining) return;
    root = remaining;
  }
  const moving: LayoutNode = { type: "pane", id: movingId };
  const destination: LayoutNode = { type: "pane", id: targetId };
  const before = edge === "left" || edge === "top";
  const replacement: LayoutNode = {
    type: "split",
    id: `split-${movingId}-${targetId}`,
    axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: before ? moving : destination,
    second: before ? destination : moving,
  };
  return { root: replace(root, targetId, replacement), groups };
}

export function combineTab(
  state: LayoutState,
  sourceId: string,
  targetId: string,
  tab: string,
): LayoutState | undefined {
  const source = state.groups.find((g) => g.id === sourceId),
    target = state.groups.find((g) => g.id === targetId);
  if (!source || !target || source === target || !source.tabs.includes(tab))
    return;
  const root =
    source.tabs.length === 1 ? remove(state.root, sourceId) : state.root;
  if (!root) return;
  const groups = state.groups
    .map((g) =>
      g.id === targetId
        ? { ...g, tabs: [...g.tabs, tab], selected: tab }
        : g.id === sourceId
          ? {
              ...g,
              tabs: g.tabs.filter((t) => t !== tab),
              selected:
                g.selected === tab
                  ? (g.tabs.find((t) => t !== tab) ?? "")
                  : g.selected,
            }
          : g,
    )
    .filter((g) => g.tabs.length);
  return { root, groups };
}

export function fitsLayout(
  state: LayoutState,
  bounds: Box,
  gap: number,
): boolean {
  const min = minimumSize(state.root, gap);
  return (
    state.groups.length <= 4 &&
    min.width <= bounds.width &&
    min.height <= bounds.height
  );
}
