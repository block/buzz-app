import { createPortal } from "react-dom";
import {
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PlusIcon } from "../../shared/design-system/icons";
import styles from "./NewMenu.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  /** The shell asks for New (its shortcut); this opens New message. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** The sidebar's + : every conversation starts in New message. */
export function NewMenu(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <ReadyNewMenu
      {...props}
      key={connection.scope ?? "disconnected"}
      session={connection.session}
      available={connection.status === "ready" || !!connection.cached}
    />
  );
}

function ReadyNewMenu({
  relay,
  navigator,
  session,
  available,
  triggerContainer,
  open,
  onOpenChange,
}: Props & { session: RelaySession; available: boolean }) {
  const scope = splitPartition(session.scope);
  const enabled = available && !!scope;
  const start = () => {
    if (relay.snapshot().session !== session || !enabled || !scope) return;
    void navigator.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      scope,
      route: { version: 1, params: "new-message" },
    });
  };
  const latest = useRef(start);
  latest.current = start;
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(false);
    latest.current();
  }, [open, onOpenChange]);
  const drag = useDraggable();
  const button = (
    // biome-ignore lint/a11y/noStaticElementInteractions: Moves the + by pointer; the button inside stays the control.
    <div
      className={drag.position ? styles.floating : styles.docked}
      style={
        drag.position
          ? { left: drag.position.x, top: drag.position.y }
          : undefined
      }
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onClickCapture={drag.onClickCapture}
      onDoubleClick={drag.reset}
    >
      <IconButton
        disabled={!enabled}
        aria-label="New message"
        title="New message"
        variant="solid"
        shape="round"
        size="md"
        icon={<PlusIcon strokeWidth={2.5} size={18} />}
        onClick={start}
      />
    </div>
  );
  if (triggerContainer === undefined) return button;
  // Moved, it floats over the whole app; otherwise it sits in the sidebar.
  if (drag.position) return createPortal(button, document.body);
  return triggerContainer && createPortal(button, triggerContainer);
}

type Point = { x: number; y: number };
const positionKey = "buzz:new-message-button:position";
// A press that moves less than this is a click, not a drag.
const dragThreshold = 4;
// Keep the whole button, and a little room, inside the window.
const edge = 8;

function savedPosition(): Point | null {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(positionKey) ?? "null",
    );
    if (
      saved &&
      typeof saved === "object" &&
      typeof (saved as Point).x === "number" &&
      typeof (saved as Point).y === "number"
    )
      return saved as Point;
  } catch {
    /* A position that can't be read starts at the default spot. */
  }
  return null;
}
function savePosition(point: Point | null) {
  try {
    if (point) localStorage.setItem(positionKey, JSON.stringify(point));
    else localStorage.removeItem(positionKey);
  } catch {
    /* The position still applies until the app restarts. */
  }
}
function subscribeResize(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}
const windowSize = () => `${window.innerWidth}x${window.innerHeight}`;

/** Drags the + anywhere in the window, remembering where it was dropped. */
function useDraggable() {
  const [position, setPosition] = useState(savedPosition);
  const [size, setSize] = useState({ width: 40, height: 40 });
  // Re-render on window resize so the button is moved back inside.
  useSyncExternalStore(subscribeResize, windowSize, () => "");
  const press = useRef<
    { start: Point; offset: Point; moved: boolean; pointer: number } | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const clamp = (point: Point): Point => ({
    x: Math.min(
      Math.max(edge, point.x),
      Math.max(edge, window.innerWidth - size.width - edge),
    ),
    y: Math.min(
      Math.max(edge, point.y),
      Math.max(edge, window.innerHeight - size.height - edge),
    ),
  });
  return {
    position: position && clamp(position),
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
      press.current = {
        start: { x: event.clientX, y: event.clientY },
        offset: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        moved: false,
        pointer: event.pointerId,
      };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const current = press.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (
        !current.moved &&
        Math.hypot(
          event.clientX - current.start.x,
          event.clientY - current.start.y,
        ) < dragThreshold
      )
        return;
      if (!current.moved) {
        current.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      setPosition(
        clamp({
          x: event.clientX - current.offset.x,
          y: event.clientY - current.offset.y,
        }),
      );
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const current = press.current;
      press.current = undefined;
      if (!current?.moved) return;
      suppressClick.current = true;
      const dropped = clamp({
        x: event.clientX - current.offset.x,
        y: event.clientY - current.offset.y,
      });
      setPosition(dropped);
      savePosition(dropped);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      // The click that ends a drag doesn't open New message.
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    reset() {
      setPosition(null);
      savePosition(null);
    },
  };
}
