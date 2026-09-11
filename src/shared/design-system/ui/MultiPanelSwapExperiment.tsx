import { Separator } from "@base-ui/react/separator";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as Pointer } from "react";
import { Button } from "./Button";
import { Panel } from "./Panel";
import { Tabs } from "./Tabs";
import {
  combineTab,
  fitsLayout,
  initialLayout,
  measureLayout,
  resizeSplit,
  splitPane,
  swapPanes,
  type Box,
  type Edge,
  type Group,
  type LayoutState,
  type SplitBox,
} from "./multiPanelLayout";
import "../styles/multi-panel-swap.css";

type Drag = {
  pointer: number;
  handle: HTMLElement;
  group: string;
  tab?: string | undefined;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  original: LayoutState;
  start: Box;
  moved: boolean;
  proposal?: LayoutState | undefined;
  lastSwap?: string | undefined;
};

/** Nested split experiment. Four visible panes is policy, not a four-slot model. */
export function MultiPanelSwapExperiment({ count }: { count: 3 | 4 }) {
  const [layout, setLayout] = useState(() => initialLayout(count));
  const state = useRef(layout);
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const geometry = useRef({ x: 0, y: 0, width: 0, height: 0, gap: 8 });
  const [splits, setSplits] = useState<SplitBox[]>([]);
  const boxes = useRef(new Map<string, Box>());
  const drag = useRef<Drag | null>(null);
  const resizing = useRef<{
    pointer: number;
    handle: HTMLElement;
    split: SplitBox;
    start: number;
    original: LayoutState;
  } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const edgeCue = useRef<HTMLDivElement>(null);
  const [announcement, announce] = useState("");
  const instantNext = useRef(true);

  function paint(instant = false) {
    const result = measureLayout(
      state.current.root,
      geometry.current,
      geometry.current.gap,
    );
    boxes.current = result.panes;
    for (const group of state.current.groups) {
      const b = boxes.current.get(group.id),
        el = elements.current.get(group.id);
      if (!b || !el) continue;
      if (instant) el.style.transition = "none";
      el.style.width = `${b.width}px`;
      el.style.height = `${b.height}px`;
      if (drag.current?.group !== group.id || drag.current.tab)
        el.style.transform = `translate(${b.x}px, ${b.y}px)`;
      if (instant) {
        el.getBoundingClientRect();
        el.style.removeProperty("transition");
      }
    }
    setSplits(result.splits);
  }
  function update(next: LayoutState, instant = true) {
    state.current = next;
    instantNext.current = instant;
    setLayout(next);
  }
  function hideSignals() {
    if (ghost.current) ghost.current.hidden = true;
    if (marker.current) marker.current.hidden = true;
    if (edgeCue.current) edgeCue.current.hidden = true;
  }
  function finish(cancel: boolean) {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (root.current) delete root.current.dataset.dragging;
    const el = elements.current.get(active.group);
    if (el) delete el.dataset.dragging;
    for (const pane of elements.current.values()) delete pane.dataset.frontmost;
    const proposal = active.proposal;
    const proposalFits =
      proposal !== undefined &&
      fitsLayout(proposal, geometry.current, geometry.current.gap);
    if (cancel) update(active.original, false);
    else if (proposalFits) update(proposal);
    else update(state.current, false);
    // A within-pane drag and cancellation can retain the same state object, so
    // React has no state change to repaint. Settle the moved DOM immediately;
    // real layout changes still paint through the layout effect.
    if (cancel || !proposalFits) paint(false);
    hideSignals();
    if (active.handle.hasPointerCapture(active.pointer))
      active.handle.releasePointerCapture(active.pointer);
    announce(cancel ? "Move cancelled" : "Layout updated");
  }
  function endResize(cancel: boolean) {
    const active = resizing.current;
    if (!active) return;
    resizing.current = null;
    if (cancel) update(active.original);
    if (root.current) delete root.current.dataset.resizing;
    if (active.handle.hasPointerCapture(active.pointer))
      active.handle.releasePointerCapture(active.pointer);
  }
  const callbacks = useRef({
    paint: (_instant: boolean) => {},
    cancel: () => {},
  });
  callbacks.current = {
    paint,
    cancel: () => {
      finish(true);
      endResize(true);
    },
  };
  const paintedLayout = useRef<LayoutState | null>(null);
  useLayoutEffect(() => {
    if (paintedLayout.current === layout) return;
    paintedLayout.current = layout;
    callbacks.current.paint(instantNext.current);
  }, [layout]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      callbacks.current.cancel();
      geometry.current = {
        x: 0,
        y: 0,
        width: el.clientWidth,
        height: el.clientHeight,
        gap: Number.parseFloat(getComputedStyle(el).columnGap) || 8,
      };
      callbacks.current.paint(true);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    const cancel = () => callbacks.current.cancel();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      const active = drag.current ?? resizing.current;
      drag.current = null;
      resizing.current = null;
      if (active?.handle.hasPointerCapture(active.pointer))
        active.handle.releasePointerCapture(active.pointer);
    };
  }, []);

  function begin(group: Group, event: Pointer<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      drag.current ||
      resizing.current
    )
      return;
    const el = elements.current.get(group.id),
      container = root.current;
    if (!el || !container) return;
    const tab =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="tab"]')
        : null;
    const b = el.getBoundingClientRect(),
      parent = container.getBoundingClientRect(),
      t = tab?.getBoundingClientRect();
    drag.current = {
      pointer: event.pointerId,
      handle: event.currentTarget,
      group: group.id,
      tab: tab?.dataset.tabValue,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - (t?.left ?? b.left),
      offsetY: event.clientY - (t?.top ?? b.top),
      original: state.current,
      start: {
        x: b.left - parent.left,
        y: b.top - parent.top,
        width: b.width,
        height: b.height,
      },
      moved: false,
    };
    if (!tab) event.currentTarget.setPointerCapture(event.pointerId);
    if (tab && ghost.current && t) {
      ghost.current.textContent = tab.textContent;
      ghost.current.style.width = `${t.width}px`;
      ghost.current.style.height = `${t.height}px`;
    }
  }
  function showEdge(box: Box, edge: Edge) {
    const cue = edgeCue.current;
    if (!cue) return;
    cue.hidden = false;
    cue.dataset.edge = edge;
    cue.style.left = `${edge === "left" ? box.x : edge === "right" ? box.x + box.width : box.x + box.width / 2}px`;
    cue.style.top = `${edge === "top" ? box.y : edge === "bottom" ? box.y + box.height : box.y + box.height / 2}px`;
  }
  function move(event: Pointer<HTMLDivElement>) {
    const active = drag.current,
      container = root.current;
    if (!active || !container || active.pointer !== event.pointerId) return;
    const dx = event.clientX - active.startX,
      dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < 6) return;
    active.moved = true;
    if (!active.handle.hasPointerCapture(active.pointer))
      active.handle.setPointerCapture(active.pointer);
    container.dataset.dragging = "true";
    const parent = container.getBoundingClientRect(),
      x = event.clientX - parent.left,
      y = event.clientY - parent.top;
    active.proposal = undefined;
    if (edgeCue.current) edgeCue.current.hidden = true;
    if (marker.current) marker.current.hidden = true;
    if (active.tab && ghost.current) {
      ghost.current.hidden = false;
      ghost.current.style.transform = `translate(${x - active.offsetX}px, ${y - active.offsetY}px)`;
    }
    if (!active.tab) {
      const el = elements.current.get(active.group);
      if (!el) return;
      for (const [id, pane] of elements.current)
        pane.dataset.frontmost = String(id === active.group);
      el.dataset.dragging = "true";
      el.style.transform = `translate(${active.start.x + dx}px, ${active.start.y + dy}px)`;
    }
    const target = state.current.groups.find((g) => {
      const b = boxes.current.get(g.id);
      return (
        b &&
        (g.id !== active.group || (!!active.tab && g.tabs.length > 1)) &&
        x >= b.x &&
        x <= b.x + b.width &&
        y >= b.y &&
        y <= b.y + b.height
      );
    });
    if (!target) {
      active.lastSwap = undefined;
      return;
    }
    const box = boxes.current.get(target.id);
    if (!box) return;
    const header = elements.current
      .get(target.id)
      ?.querySelector(".multi-swap-header");
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    if (active.tab && target.id !== active.group && y < box.y + headerHeight) {
      active.proposal = combineTab(
        state.current,
        active.group,
        target.id,
        active.tab,
      );
      const last = header
        ?.querySelector('[role="tab"]:last-child')
        ?.getBoundingClientRect();
      if (last && marker.current && active.proposal) {
        marker.current.hidden = false;
        marker.current.style.left = `${last.right - parent.left + 4}px`;
        marker.current.style.top = `${last.top - parent.top}px`;
        marker.current.style.height = `${last.height}px`;
      }
      return;
    }
    // Pane-local targets: no layout changes until release. Bounds are the
    // layout boxes, not transformed moving elements or painted cues.
    const distances: { edge: Edge; distance: number }[] = [
      { edge: "left", distance: x - box.x },
      { edge: "right", distance: box.x + box.width - x },
      { edge: "top", distance: y - box.y },
      { edge: "bottom", distance: box.y + box.height - y },
    ];
    const nearest = distances.sort((a, b) => a.distance - b.distance)[0];
    if (!nearest) return;
    const band = Math.min(
      36,
      (nearest.edge === "left" || nearest.edge === "right"
        ? box.width
        : box.height) * 0.18,
    );
    const approachingEdge =
      nearest.edge === "top" || nearest.edge === "bottom"
        ? Math.abs(dy) > 32
        : Math.abs(dx) > 32;
    if (nearest.distance < band && approachingEdge) {
      const proposal = splitPane(
        state.current,
        active.group,
        target.id,
        nearest.edge,
        active.tab,
      );
      if (
        proposal &&
        fitsLayout(proposal, geometry.current, geometry.current.gap)
      ) {
        active.proposal = proposal;
        showEdge(box, nearest.edge);
      }
      return;
    }
    // Only equal-sized boxes can trade positions without resizing during drag.
    // Different-sized moves use an edge cue and commit their sizing on release.
    const parallelMotion =
      Math.abs(dx) > Math.abs(dy) * 1.5 || Math.abs(dy) > Math.abs(dx) * 1.5;
    const alongSharedAxis =
      Math.abs(active.start.y - box.y) < 1
        ? Math.abs(dx) > Math.abs(dy) * 1.5
        : Math.abs(dy) > Math.abs(dx) * 1.5;
    if (
      !active.tab &&
      target.id !== active.lastSwap &&
      parallelMotion &&
      alongSharedAxis
    ) {
      const own = boxes.current.get(active.group);
      if (
        own &&
        Math.abs(own.width - box.width) < 1 &&
        Math.abs(own.height - box.height) < 1
      ) {
        active.lastSwap = target.id;
        state.current = {
          ...state.current,
          root: swapPanes(state.current.root, active.group, target.id),
        };
        // Do not reorder React children mid-pointer-capture.
        paint();
      }
    }
  }
  function setRatio(split: SplitBox, ratio: number) {
    update({
      ...state.current,
      root: resizeSplit(
        state.current.root,
        split.id,
        Math.max(split.minRatio, Math.min(split.maxRatio, ratio)),
      ),
    });
  }
  const orderedGroups = layout.groups;
  return (
    <section
      className="multi-swap-experiment"
      aria-label={`${count} panels playground`}
    >
      <div className="multi-swap-intro">
        <h2 className="text-heading">{count} panels</h2>
        <Button
          size="compact"
          onClick={() => {
            callbacks.current.cancel();
            update(
              initialLayout(
                count,
                geometry.current.width,
                geometry.current.gap,
              ),
            );
          }}
        >
          Reset {count} panels
        </Button>
      </div>
      <p className="text-body text-secondary">
        Drag header space across equal-size panes to swap live. Drop near a
        pane’s edge to split that area, leaving other areas intact. Sizes change
        only on release. Drag a title into another header to combine; drag a
        grouped tab to a pane edge to separate. Up to four visible panes.
      </p>
      <div className="multi-swap-backdrop">
        <div className="multi-swap-stage" ref={root}>
          {orderedGroups.map((group) => (
            <div
              className="multi-swap-placement"
              key={group.id}
              data-group={group.id}
              ref={(el) => {
                if (el) elements.current.set(group.id, el);
                else elements.current.delete(group.id);
              }}
            >
              <Panel aria-label={`Pane ${group.tabs.join(", ")}`}>
                <div
                  className="multi-swap-header"
                  onPointerDown={(e) => begin(group, e)}
                  onPointerMove={move}
                  onPointerUp={(e) => {
                    if (drag.current?.pointer === e.pointerId) finish(false);
                  }}
                  onPointerCancel={(e) => {
                    if (drag.current?.pointer === e.pointerId) finish(true);
                  }}
                  onLostPointerCapture={(e) => {
                    if (e.target === e.currentTarget) finish(true);
                  }}
                >
                  <Tabs
                    variant="workspace"
                    value={group.selected}
                    items={group.tabs.map((t) => ({ value: t, label: t }))}
                    label={`Pane ${group.id} tabs`}
                    onValueChange={(value) =>
                      update({
                        ...state.current,
                        groups: state.current.groups.map((g) =>
                          g.id === group.id ? { ...g, selected: value } : g,
                        ),
                      })
                    }
                  />
                </div>
              </Panel>
            </div>
          ))}
          {splits.map((split, index) => (
            <Separator
              key={split.id}
              className="multi-swap-divider"
              data-axis={split.axis}
              orientation={
                split.axis === "horizontal" ? "vertical" : "horizontal"
              }
              tabIndex={0}
              aria-label={`Resize divider ${index + 1}`}
              aria-valuemin={Math.round(split.minRatio * 100)}
              aria-valuemax={Math.round(split.maxRatio * 100)}
              aria-valuenow={Math.round(split.ratio * 100)}
              style={
                split.axis === "horizontal"
                  ? {
                      left:
                        split.x +
                        (split.width - geometry.current.gap) * split.ratio +
                        geometry.current.gap / 2,
                      top: split.y,
                      height: split.height,
                    }
                  : {
                      left: split.x,
                      top:
                        split.y +
                        (split.height - geometry.current.gap) * split.ratio +
                        geometry.current.gap / 2,
                      width: split.width,
                    }
              }
              onPointerDown={(e) => {
                if (
                  e.button !== 0 ||
                  !e.isPrimary ||
                  drag.current ||
                  resizing.current
                )
                  return;
                e.preventDefault();
                e.currentTarget.focus();
                resizing.current = {
                  pointer: e.pointerId,
                  handle: e.currentTarget,
                  split,
                  start: split.axis === "horizontal" ? e.clientX : e.clientY,
                  original: state.current,
                };
                if (root.current) root.current.dataset.resizing = "true";
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const active = resizing.current;
                if (!active || active.pointer !== e.pointerId) return;
                const delta =
                  (split.axis === "horizontal" ? e.clientX : e.clientY) -
                  active.start;
                const size =
                  (split.axis === "horizontal"
                    ? active.split.width
                    : active.split.height) - geometry.current.gap;
                setRatio(active.split, active.split.ratio + delta / size);
              }}
              onPointerUp={(e) => {
                if (resizing.current?.pointer === e.pointerId) endResize(false);
              }}
              onPointerCancel={() => endResize(true)}
              onLostPointerCapture={() => endResize(true)}
              onKeyDown={(e) => {
                if (drag.current || resizing.current) return;
                const decrease =
                    split.axis === "horizontal" ? "ArrowLeft" : "ArrowUp",
                  increase =
                    split.axis === "horizontal" ? "ArrowRight" : "ArrowDown";
                if (![decrease, increase, "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                setRatio(
                  split,
                  e.key === "Home"
                    ? split.minRatio
                    : e.key === "End"
                      ? split.maxRatio
                      : split.ratio + (e.key === decrease ? -0.03 : 0.03),
                );
              }}
            />
          ))}
          <div
            className="multi-swap-ghost text-body"
            ref={ghost}
            hidden
            aria-hidden="true"
          />
          <div
            className="multi-swap-insertion"
            ref={marker}
            hidden
            aria-hidden="true"
          />
          <div
            className="multi-swap-cue"
            ref={edgeCue}
            hidden
            aria-hidden="true"
          />
        </div>
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
