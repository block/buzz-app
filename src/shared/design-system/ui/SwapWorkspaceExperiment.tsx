import { createPortal } from "react-dom";
import { Separator } from "@base-ui/react/separator";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Button } from "./Button";
import { Panel } from "./Panel";
import { Tabs } from "./Tabs";
import "../styles/swap-workspace.css";

type PanelId = "One" | "Two";
type Order = [PanelId, PanelId];
type Axis = "horizontal" | "vertical";
type Edge = "top" | "bottom" | "left" | "right";
type Gesture = {
  intent: "move" | "combine" | "separate";
  splitEdge?: Edge | undefined;
  id: PanelId;
  pointerId: number;
  handle: HTMLDivElement;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  left: number;
  top: number;
  original: Order;
  originalAxis: Axis;
  tabGrab: { x: number; y: number; width: number; height: number };
  insertion: { x: number; y: number; height: number };
  targetHeader: { x: number; y: number; width: number; height: number };
};
type ResizeGesture = {
  pointerId: number;
  handle: HTMLDivElement;
  start: number;
  size: number;
  originalShare: number;
};
const opposite = (id: PanelId): PanelId => (id === "One" ? "Two" : "One");

/** Two live panels, two orientations, independent remembered proportions. POC only. */
export function SwapWorkspaceExperiment() {
  const [combined, setCombined] = useState(false);
  const combinedRef = useRef(false);
  const paintedCombined = useRef(false);
  const [selected, setSelected] = useState<PanelId>("One");
  const [arrived, setArrived] = useState<PanelId>();
  const [tabOrder, setTabOrder] = useState<Order>(["One", "Two"]);
  const tabGhost = useRef<HTMLDivElement>(null);
  const insertion = useRef<HTMLDivElement>(null);
  const combineTarget = useRef(false);
  const order = useRef<Order>(["One", "Two"]);
  const axis = useRef<Axis>("horizontal");
  const [orientation, setOrientation] = useState<Axis>("horizontal");
  const shares = useRef({ horizontal: 0.5, vertical: 0.5 });
  const stage = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<PanelId, HTMLDivElement>());
  const divider = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const resize = useRef<ResizeGesture | null>(null);
  const geometry = useRef({ width: 0, height: 0, gap: 0, minimum: 0 });
  const [announcement, setAnnouncement] = useState("");

  function dimensions() {
    const g = geometry.current;
    const available = Math.max(
      0,
      (axis.current === "horizontal" ? g.width : g.height) - g.gap,
    );
    return { available, minimum: Math.min(available / 2, g.minimum) };
  }
  function sizeOf(id: PanelId) {
    const { available, minimum } = dimensions();
    const one = Math.max(
      minimum,
      Math.min(available - minimum, available * shares.current[axis.current]),
    );
    return id === "One" ? one : available - one;
  }
  function boxOf(id: PanelId) {
    const g = geometry.current;
    if (combinedRef.current)
      return { x: 0, y: 0, width: g.width, height: g.height };
    const offset =
      id === order.current[0] ? 0 : sizeOf(order.current[0]) + g.gap;
    return axis.current === "horizontal"
      ? { x: offset, y: 0, width: sizeOf(id), height: g.height }
      : { x: 0, y: offset, width: g.width, height: sizeOf(id) };
  }
  function arrange(next: Order, nextAxis = axis.current) {
    // Structural changes are one layout update, not a journey through partial
    // sizes/positions. Ordinary same-orientation swaps keep their slide motion.
    const structuralChange =
      nextAxis !== axis.current ||
      paintedCombined.current !== combinedRef.current;
    paintedCombined.current = combinedRef.current;
    if (structuralChange) {
      for (const element of panels.current.values())
        element.style.transition = "none";
    }
    order.current = next;
    if (axis.current !== nextAxis) {
      axis.current = nextAxis;
      setOrientation(nextAxis);
    }
    if (stage.current) stage.current.dataset.axis = nextAxis;
    for (const [id, element] of panels.current) {
      const box = boxOf(id);
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
      if (gesture.current?.id !== id)
        element.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
    }
    if (structuralChange) {
      stage.current?.getBoundingClientRect();
      for (const element of panels.current.values())
        element.style.removeProperty("transition");
    }
    const { available, minimum } = dimensions();
    const seam = divider.current;
    if (!seam || !available) return;
    const size = sizeOf(next[0]);
    seam.style.left =
      nextAxis === "horizontal" ? `${size + geometry.current.gap / 2}px` : "0";
    seam.style.top =
      nextAxis === "vertical" ? `${size + geometry.current.gap / 2}px` : "0";
    seam.setAttribute(
      "aria-valuenow",
      String(Math.round((size / available) * 100)),
    );
    seam.setAttribute(
      "aria-valuemin",
      String(Math.ceil((minimum / available) * 100)),
    );
    seam.setAttribute(
      "aria-valuemax",
      String(Math.floor(((available - minimum) / available) * 100)),
    );
    seam.setAttribute(
      "aria-valuetext",
      `${next[0]} ${Math.round((size / available) * 100)} percent; ${next[1]} ${Math.round(((available - size) / available) * 100)} percent`,
    );
  }
  function resizeFirst(value: number) {
    const { available, minimum } = dimensions();
    if (!available) return;
    const share =
      Math.max(minimum, Math.min(available - minimum, value)) / available;
    shares.current[axis.current] =
      order.current[0] === "One" ? share : 1 - share;
    arrange(order.current);
  }
  function finishResize(cancel: boolean) {
    const active = resize.current;
    if (!active) return;
    resize.current = null;
    if (cancel) shares.current[axis.current] = active.originalShare;
    arrange(order.current);
    stage.current?.getBoundingClientRect();
    if (stage.current) delete stage.current.dataset.resizing;
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId);
    setAnnouncement(cancel ? "Resize cancelled." : "Panel sizes updated.");
  }
  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      gesture.current ||
      resize.current ||
      !dimensions().available
    )
      return;
    event.preventDefault();
    event.currentTarget.focus();
    if (stage.current) stage.current.dataset.resizing = "true";
    arrange(order.current);
    resize.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      start: axis.current === "horizontal" ? event.clientX : event.clientY,
      size: sizeOf(order.current[0]),
      originalShare: shares.current[axis.current],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const active = resize.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const current =
      axis.current === "horizontal" ? event.clientX : event.clientY;
    resizeFirst(active.size + current - active.start);
  }
  function showCue(edge?: "top" | "bottom" | "left" | "right", active = false) {
    if (!cue.current) return;
    cue.current.hidden = !edge;
    if (edge) cue.current.dataset.edge = edge;
    cue.current.dataset.active = String(active);
  }
  function previewCombine(eligible: boolean) {
    combineTarget.current = eligible;
    if (insertion.current) insertion.current.hidden = !eligible;
  }
  function combinePanels(id: PanelId) {
    setTabOrder([opposite(id), id]);
    combinedRef.current = true;
    setSelected(id);
    setArrived(id);
    setCombined(true);
  }
  function finish(cancel: boolean) {
    const active = gesture.current;
    if (!active) return;
    delete document.documentElement.dataset.swapDragging;
    const combine =
      !cancel && active.intent === "combine" && combineTarget.current;
    if (combine) combinePanels(active.id);
    const split =
      !cancel && active.intent !== "combine" ? active.splitEdge : undefined;
    if (split) {
      combinedRef.current = false;
      setCombined(false);
      setArrived(undefined);
      order.current =
        split === "left" || split === "top"
          ? [active.id, opposite(active.id)]
          : [opposite(active.id), active.id];
    }
    previewCombine(false);
    if (tabGhost.current) tabGhost.current.hidden = true;
    gesture.current = null;
    const element = panels.current.get(active.id);
    if (element) delete element.dataset.dragging;
    if (stage.current) delete stage.current.dataset.dragging;
    showCue();
    arrange(
      cancel ? active.original : order.current,
      cancel
        ? active.originalAxis
        : split
          ? split === "left" || split === "right"
            ? "horizontal"
            : "vertical"
          : axis.current,
    );
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId);
    setAnnouncement(
      split
        ? `${active.id} separated ${split}.`
        : combine
          ? "Panels combined as tabs."
          : cancel
            ? "Move cancelled."
            : `${order.current.join(" then ")}, ${axis.current === "horizontal" ? "side by side" : "top to bottom"}.`,
    );
  }

  const callbacks = useRef({ cancel: () => {}, paint: () => {} });
  callbacks.current = {
    cancel: () => {
      finish(true);
      finishResize(true);
    },
    paint: () => arrange(order.current),
  };
  useEffect(() => {
    const container = stage.current;
    if (!container) return;
    const measure = () => {
      callbacks.current.cancel();
      geometry.current = {
        width: container.clientWidth,
        height: container.clientHeight,
        gap: Number.parseFloat(getComputedStyle(container).columnGap) || 0,
        minimum:
          10 *
          Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ),
      };
      container.dataset.resizing = "true";
      callbacks.current.paint();
      container.getBoundingClientRect();
      delete container.dataset.resizing;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    const cancel = () => callbacks.current.cancel();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (gesture.current || resize.current)) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      delete document.documentElement.dataset.swapDragging;
      observer.disconnect();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      const active = gesture.current ?? resize.current;
      if (tabGhost.current) tabGhost.current.hidden = true;
      if (insertion.current) insertion.current.hidden = true;
      gesture.current = null;
      resize.current = null;
      if (active?.handle.hasPointerCapture(active.pointerId))
        active.handle.releasePointerCapture(active.pointerId);
    };
  }, []);

  function begin(id: PanelId, event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      gesture.current ||
      resize.current
    )
      return;
    const element = panels.current.get(id);
    const container = stage.current;
    if (!element || !container || !geometry.current.width) return;
    const box = element.getBoundingClientRect(),
      parent = container.getBoundingClientRect();
    const destinationHeader = combinedRef.current
      ? event.currentTarget.getBoundingClientRect()
      : panels.current
          .get(opposite(id))
          ?.querySelector(".swap-workspace-handle")
          ?.getBoundingClientRect();
    if (!destinationHeader) return;
    const title =
      event.target instanceof Element
        ? event.target.closest('[role="tab"]')
        : null;
    const tabBox = title?.getBoundingClientRect();
    const destinationTab = combinedRef.current
      ? tabBox
      : panels.current
          .get(opposite(id))
          ?.querySelector('[role="tab"]')
          ?.getBoundingClientRect();
    if (!destinationTab) return;
    if (combinedRef.current && !title) return;
    const intent = combinedRef.current
      ? "separate"
      : title
        ? "combine"
        : "move";
    gesture.current = {
      tabGrab: {
        x: event.clientX - (tabBox?.left ?? box.left),
        y: event.clientY - (tabBox?.top ?? box.top),
        width: tabBox?.width ?? 0,
        height: tabBox?.height ?? 0,
      },
      insertion: {
        x: destinationTab.right - parent.left,
        y: destinationTab.top - parent.top,
        height: destinationTab.height,
      },
      targetHeader: {
        x: destinationHeader.left - parent.left,
        y: destinationHeader.top - parent.top,
        width: destinationHeader.width,
        height: destinationHeader.height,
      },
      intent,
      id,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - box.left,
      grabY: event.clientY - box.top,
      left: parent.left,
      top: parent.top,
      original: [...order.current],
      originalAxis: axis.current,
    };
    previewCombine(false);
    if (intent !== "move") {
      // Only the title travels. Neither live pane nor its real tab changes.
      if (tabGhost.current && tabBox) {
        tabGhost.current.textContent = id;
        tabGhost.current.style.width = `${tabBox.width}px`;
        tabGhost.current.style.height = `${tabBox.height}px`;
      }
      if (insertion.current) {
        insertion.current.style.left = `${gesture.current.insertion.x}px`;
        insertion.current.style.top = `${gesture.current.insertion.y}px`;
        insertion.current.style.height = `${gesture.current.insertion.height}px`;
      }
      if (intent !== "separate")
        event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    // Frontmost belongs to the last picked-up panel, not the active pointer.
    // Keep it through release/cancellation so settling cannot slip underneath.
    for (const [panelId, placement] of panels.current) {
      if (panelId === id) placement.dataset.frontmost = "true";
      else delete placement.dataset.frontmost;
    }
    document.documentElement.dataset.swapDragging = "";
    element.dataset.dragging = "true";
    container.dataset.dragging = "true";
    element.style.transform = `translate3d(${box.left - parent.left}px, ${box.top - parent.top}px, 0)`;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const element = panels.current.get(active.id);
    if (!element) return;
    const dx = event.clientX - active.startX,
      dy = event.clientY - active.startY;
    if (Math.hypot(dx, dy) >= 6)
      document.documentElement.dataset.swapDragging = "";
    if (active.intent === "separate") {
      const px = event.clientX - active.left,
        py = event.clientY - active.top;
      const { width, height } = geometry.current;
      const distance = Math.hypot(dx, dy);
      if (distance >= 6 && !active.handle.hasPointerCapture(event.pointerId))
        active.handle.setPointerCapture(event.pointerId);
      // Stable outer edges, never the moving pill. Movement must leave the
      // original tab deliberately so a click near the top doesn't detach it.
      const edges: { edge: Edge; distance: number; eligible: boolean }[] = [
        { edge: "left", distance: Math.abs(px), eligible: dx < -24 },
        { edge: "right", distance: Math.abs(width - px), eligible: dx > 24 },
        { edge: "top", distance: Math.abs(py), eligible: dy < -24 },
        { edge: "bottom", distance: Math.abs(height - py), eligible: dy > 24 },
      ];
      const candidate = edges
        .filter((e) => e.eligible)
        .sort((a, b) => a.distance - b.distance)[0];
      const inReach =
        px >= -48 && px <= width + 48 && py >= -48 && py <= height + 48;
      const band =
        candidate?.edge === "left" || candidate?.edge === "right"
          ? Math.min(72, width * 0.16)
          : Math.min(72, height * 0.16);
      active.splitEdge =
        inReach &&
        candidate &&
        candidate.distance <=
          band + (active.splitEdge === candidate.edge ? 12 : 0)
          ? candidate.edge
          : undefined;
      showCue(active.splitEdge, true);
      if (tabGhost.current) {
        tabGhost.current.hidden = distance < 6;
        tabGhost.current.style.transform = `translate3d(${event.clientX - active.tabGrab.x}px, ${event.clientY - active.tabGrab.y}px, 0)`;
      }
      return;
    }
    if (active.intent === "combine") {
      // Panes remain fixed; only a non-interactive title pill follows the pointer.
      const target = active.targetHeader;
      const px = event.clientX - active.left,
        py = event.clientY - active.top;
      const tolerance = combineTarget.current ? 12 : 0;
      previewCombine(
        Math.hypot(dx, dy) >= 6 &&
          px >= target.x - tolerance &&
          px <= target.x + target.width + tolerance &&
          py >= target.y - tolerance &&
          py <= target.y + target.height + tolerance,
      );
      if (tabGhost.current) {
        tabGhost.current.hidden = Math.hypot(dx, dy) < 6;
        tabGhost.current.style.transform = `translate3d(${event.clientX - active.tabGrab.x}px, ${event.clientY - active.tabGrab.y}px, 0)`;
      }
      return;
    }
    const verticalIntent = active.originalAxis === "horizontal";
    const displacement = verticalIntent ? dy : dx;
    const coordinate = verticalIntent
      ? event.clientY - active.top
      : event.clientX - active.left;
    const extent = verticalIntent
      ? geometry.current.height
      : geometry.current.width;
    const band = Math.min(72, extent * 0.16);
    // One cue only, selected by deliberate movement perpendicular to the pair.
    const edge =
      Math.abs(displacement) < 16
        ? undefined
        : verticalIntent
          ? displacement < 0
            ? "top"
            : "bottom"
          : displacement < 0
            ? "left"
            : "right";
    const wasPreviewing = active.splitEdge !== undefined;
    const activationBand = band + (wasPreviewing ? 20 : 0);
    const activated =
      !!edge &&
      Math.abs(displacement) > 32 &&
      (displacement < 0
        ? coordinate < activationBand
        : coordinate > extent - activationBand);
    showCue(edge, activated);
    active.splitEdge = activated ? edge : undefined;
    // An edge only proposes a different orientation. Keep both sizes unchanged
    // until release; ordinary swaps within this orientation still happen live.
    if (!activated) {
      const travel = sizeOf(opposite(active.id)) + geometry.current.gap;
      const position =
        axis.current === "horizontal"
          ? event.clientX - active.left - active.grabX
          : event.clientY - active.top - active.grabY;
      const slot = order.current.indexOf(active.id);
      if (
        (slot === 0 && position > travel * 0.58) ||
        (slot === 1 && position < travel * 0.42)
      )
        arrange([order.current[1], order.current[0]]);
    }
    const box = boxOf(active.id);
    // Keep the header under the grab point when a full-width panel becomes narrow.
    const grabX = Math.min(active.grabX, Math.max(0, box.width - 24));
    element.style.transform = `translate3d(${event.clientX - active.left - grabX}px, ${event.clientY - active.top - active.grabY}px, 0)`;
  }

  return (
    <div className="swap-workspace-experiment">
      <div className="swap-workspace-intro">
        <p id="swap-instructions" className="text-body text-secondary">
          Drag empty header space to rearrange. Drag the title onto the other
          panel’s header to combine as tabs. A translucent title pill follows
          your pointer; the purple line marks insertion. Both panes stay put
          until release. Move toward the top or bottom to stack vertically; from
          a vertical pair, move toward either side to return sideways. Only the
          edge you approach shows a small cue; orientation and size change only
          on release. Escape cancels. Arrow keys on a header choose its
          position; drag the divider to resize. Each orientation remembers its
          sizes.
        </p>
        <Button
          size="compact"
          onClick={() => {
            callbacks.current.cancel();
            combinedRef.current = false;
            setCombined(false);
            shares.current = { horizontal: 0.5, vertical: 0.5 };
            arrange(["One", "Two"], "horizontal");
          }}
        >
          Reset
        </Button>
      </div>
      <div className="swap-workspace-backdrop">
        <div className="swap-workspace-stage" ref={stage}>
          {(["One", "Two"] as const).map((id) => (
            <div
              key={id}
              className="swap-workspace-placement"
              data-panel={id}
              hidden={combined && selected !== id}
              ref={(element) => {
                if (element) panels.current.set(id, element);
                else panels.current.delete(id);
              }}
            >
              <Panel id={`swap-panel-${id}`} aria-label={`Panel ${id}`}>
                <div
                  hidden={combined}
                  className="swap-workspace-handle"
                  onPointerDown={(event) => begin(id, event)}
                  onPointerMove={move}
                  onPointerUp={(event) => {
                    if (gesture.current?.pointerId === event.pointerId)
                      finish(false);
                  }}
                  onPointerCancel={(event) => {
                    if (gesture.current?.pointerId === event.pointerId)
                      finish(true);
                  }}
                  onLostPointerCapture={() => finish(true)}
                >
                  <div
                    onKeyDownCapture={(event) => {
                      if (
                        !gesture.current &&
                        !resize.current &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        combinePanels(id);
                        arrange(order.current);
                        setAnnouncement("Panels combined as tabs.");
                        return;
                      }
                      if (
                        gesture.current ||
                        resize.current ||
                        ![
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                        ].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      const horizontal =
                        event.key === "ArrowLeft" || event.key === "ArrowRight";
                      const first =
                        event.key === "ArrowLeft" || event.key === "ArrowUp";
                      arrange(
                        first ? [id, opposite(id)] : [opposite(id), id],
                        horizontal ? "horizontal" : "vertical",
                      );
                      setAnnouncement(
                        `${id} moved ${event.key.slice(5).toLowerCase()}.`,
                      );
                    }}
                  >
                    <Tabs
                      variant="workspace"
                      value={id}
                      items={[{ value: id, label: id }]}
                      label={`Panel ${id} title`}
                      onValueChange={() => {}}
                    />
                  </div>
                </div>
              </Panel>
            </div>
          ))}
          <Separator
            ref={divider}
            className="swap-workspace-divider"
            hidden={combined}
            orientation={
              orientation === "horizontal" ? "vertical" : "horizontal"
            }
            tabIndex={0}
            aria-label="Resize panels"
            aria-controls="swap-panel-One swap-panel-Two"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={50}
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={(event) => {
              if (resize.current?.pointerId === event.pointerId)
                finishResize(false);
            }}
            onPointerCancel={(event) => {
              if (resize.current?.pointerId === event.pointerId)
                finishResize(true);
            }}
            onLostPointerCapture={() => finishResize(true)}
            onDoubleClick={() => {
              if (!gesture.current && !resize.current) {
                shares.current[axis.current] = 0.5;
                arrange(order.current);
              }
            }}
            onKeyDown={(event) => {
              if (gesture.current || resize.current) return;
              const decrease =
                axis.current === "horizontal" ? "ArrowLeft" : "ArrowUp";
              const increase =
                axis.current === "horizontal" ? "ArrowRight" : "ArrowDown";
              if (![decrease, increase, "Home", "End"].includes(event.key))
                return;
              event.preventDefault();
              const { available, minimum } = dimensions();
              if (stage.current) stage.current.dataset.resizing = "true";
              resizeFirst(
                event.key === "Home"
                  ? minimum
                  : event.key === "End"
                    ? available - minimum
                    : sizeOf(order.current[0]) +
                      (event.key === decrease ? -1 : 1) *
                        available *
                        (event.shiftKey ? 0.1 : 0.02),
              );
              stage.current?.getBoundingClientRect();
              if (stage.current) delete stage.current.dataset.resizing;
            }}
          />
          {combined ? (
            <div
              className="swap-workspace-tabs"
              style={{ left: 0, top: 0, width: geometry.current.width }}
              onPointerDownCapture={(event) => {
                const tab =
                  event.target instanceof Element
                    ? event.target.closest<HTMLElement>('[role="tab"]')
                    : null;
                const id = tab?.dataset.tabValue;
                if (id === "One" || id === "Two") begin(id, event);
              }}
              onPointerMove={move}
              onPointerUp={(event) => {
                if (gesture.current?.pointerId === event.pointerId)
                  finish(false);
              }}
              onPointerCancel={(event) => {
                if (gesture.current?.pointerId === event.pointerId)
                  finish(true);
              }}
              onLostPointerCapture={() => finish(true)}
            >
              <Tabs
                variant="workspace"
                value={selected}
                arrivalValue={arrived}
                onValueChange={(value) => {
                  setSelected(value);
                  if (value !== selected) setArrived(undefined);
                }}
                label="Combined panels"
                items={tabOrder.map((id) => ({ value: id, label: id }))}
              />
            </div>
          ) : null}
          <div
            ref={insertion}
            className="swap-tab-insertion"
            hidden
            aria-hidden="true"
          />
          <div
            ref={cue}
            className="swap-workspace-cue"
            hidden
            aria-hidden="true"
          />
        </div>
      </div>
      {createPortal(
        <div
          ref={tabGhost}
          className="swap-tab-ghost text-body"
          hidden
          aria-hidden="true"
        />,
        document.body,
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <p className="text-body-sm text-tertiary">
        Two-panel experiment. Widths and heights are remembered separately until
        you reset or leave this page. Drag a combined tab to an edge to separate
        it. No saved layout.
      </p>
    </div>
  );
}
