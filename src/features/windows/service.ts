// Desktop tab windows. Rust owns the layout (which pages live in which window);
// this reader mirrors it for one webview and filters the page registry to the
// tabs assigned to this window's label. Web is always the single main window.
import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RegisteredPage } from "../pages/service";
import type { RegisteredPanel } from "../panels/service";

export const MAIN_WINDOW = "main";
const EVENT = "buzz:windows";
const ACTIVATE = "buzz:windows:activate";
const DROP_TARGET = "buzz:windows:drop-target";
/** Launcher panels share the layout with pages under a distinct tab key. */
export const panelTabKey = (panel: RegisteredPanel) => `panel:${panel.key}`;

export type TabWindow = Readonly<{ label: string; tabs: readonly string[] }>;
export type WindowLayout = Readonly<{ windows: readonly TabWindow[] }>;
export type WindowSnapshot = Readonly<{
  status: "loading" | "ready";
  layout: WindowLayout;
  /** Detaching is switched on by the `buzz.windows` plugin; off, tabs stay put. */
  enabled: boolean;
  /** The tab most recently moved into this window; `seq` distinguishes repeats. */
  activate?: Readonly<{ key: string; seq: number }>;
  /** The tab dragged from another window that is hovering this one, if any. */
  dropTarget?: Readonly<{ tab: string }>;
}>;
/** `main`, `new`, or the label of an open detached window. */
export type WindowDestination = string;

export type WindowTransport = Readonly<{
  label: string;
  layout(): Promise<unknown>;
  listen(listener: (layout: unknown) => void): Promise<() => void>;
  /** A tab moved into this window; it should become the selected tab. */
  activation(listener: (tabKey: unknown) => void): Promise<() => void>;
  dropTarget(listener: (payload: unknown) => void): Promise<() => void>;
  moveTab(pageKey: string, destination: WindowDestination): Promise<unknown>;
  dropTab(pageKey: string, x: number, y: number): Promise<unknown>;
  dragBegin(
    tabKey: string,
    spec: GhostSpec,
    x: number,
    y: number,
  ): Promise<void>;
  dragMove(x: number, y: number): Promise<void>;
  dragEnd(): Promise<void>;
  /** Return every tab to main and close detached windows. */
  reset(): Promise<unknown>;
  close(): Promise<void>;
}>;

/** Appearance of the native pill: the lifted tab's size, icon and resolved styles. */
export type GhostSpec = Readonly<{
  title: string;
  /** Serialized `<svg>`/`<img>` from the tab; the ghost page renders nothing else. */
  icon?: string;
  /** Rendered icon box (CSS length), since the ghost lacks the tab's stylesheet. */
  iconSize?: string;
  width: number;
  height: number;
  background: string;
  color: string;
  font: string;
  padding: string;
  gap: string;
  radius: string;
  /** The tab's own box-shadow (glass rims); the ghost adds its drop shadow. */
  shadow: string;
}>;

/**
 * Native drag ghost that stays visible outside this window. Coordinates are
 * the pill's top-left corner on the logical screen.
 */
export type TabDrag = Readonly<{
  begin(tabKey: string, spec: GhostSpec, x: number, y: number): void;
  move(x: number, y: number): void;
  end(): void;
}>;

export type WindowHost = Readonly<{
  label: string;
  isMain: boolean;
  snapshot(): WindowSnapshot;
  subscribe(listener: () => void): () => void;
  /** Absent where windows cannot be detached (web). */
  moveTab?: (pageKey: string, destination: WindowDestination) => Promise<void>;
  /** Release a dragged tab at logical screen coordinates: merge or open there. */
  dropTab?: (pageKey: string, x: number, y: number) => Promise<void>;
  drag?: TabDrag;
  /** Absent for the main window and on web. */
  close?: () => Promise<void>;
  /**
   * Switch detaching on for this window; the disposer switches it off and, on
   * desktop, returns every tab to main. Host teardown never resets the layout.
   */
  enable(): () => void;
  dispose(): void;
}>;

/** Plugin-facing view of the window this plugin instance runs in. */
export type Windows = Pick<
  WindowHost,
  "label" | "isMain" | "snapshot" | "subscribe" | "enable"
>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    windows: Windows;
  }
}

export class WindowsService extends Service implements Windows {
  readonly label: string;
  readonly isMain: boolean;
  constructor(
    ctx: Context,
    private readonly host: WindowHost,
  ) {
    super(ctx, "windows");
    this.label = host.label;
    this.isMain = host.isMain;
  }
  snapshot = () => this.host.snapshot();
  subscribe = (listener: () => void) => this.host.subscribe(listener);
  enable = () => this.host.enable();
}

const EMPTY: WindowLayout = Object.freeze({ windows: Object.freeze([]) });

export function parseLayout(value: unknown): WindowLayout {
  if (!value || typeof value !== "object" || !("windows" in value))
    throw new Error("Invalid window layout");
  const windows = value.windows;
  if (!Array.isArray(windows)) throw new Error("Invalid window layout");
  return Object.freeze({
    windows: Object.freeze(
      windows.map((window: unknown): TabWindow => {
        if (
          !window ||
          typeof window !== "object" ||
          !("label" in window) ||
          typeof window.label !== "string" ||
          !("tabs" in window) ||
          !Array.isArray(window.tabs) ||
          !window.tabs.every((tab) => typeof tab === "string")
        )
          throw new Error("Invalid window layout");
        return Object.freeze({
          label: window.label,
          tabs: Object.freeze([...(window.tabs as string[])]),
        });
      }),
    ),
  });
}

function windowTabs<T>(
  layout: WindowLayout,
  label: string,
  items: readonly T[],
  key: (item: T) => string,
): readonly T[] {
  if (label === MAIN_WINDOW) {
    const detached = new Set(layout.windows.flatMap((window) => window.tabs));
    return items.filter((item) => !detached.has(key(item)));
  }
  const tabs = layout.windows.find((window) => window.label === label)?.tabs;
  return tabs ? items.filter((item) => tabs.includes(key(item))) : [];
}

/** Pages shown in `label`: main owns every page not assigned to a detached window. */
export function windowPages(
  layout: WindowLayout,
  label: string,
  pages: readonly RegisteredPage[],
): readonly RegisteredPage[] {
  return windowTabs(layout, label, pages, (page) => page.key);
}

/** Launcher panels in `label`: launchers in main, full tabs in detached windows. */
export function windowPanels(
  layout: WindowLayout,
  label: string,
  panels: readonly RegisteredPanel[],
): readonly RegisteredPanel[] {
  return windowTabs(
    layout,
    label,
    panels.filter((panel) => panel.launcher),
    panelTabKey,
  );
}

/** Display names for move targets, stable across windows: Window 2, Window 3… */
export function windowTitle(layout: WindowLayout, label: string): string {
  if (label === MAIN_WINDOW) return "Main window";
  const index = layout.windows.findIndex((window) => window.label === label);
  return index === -1 ? "Window" : `Window ${index + 2}`;
}

export function tauriWindowTransport(): WindowTransport {
  // A partial Tauri runtime (IPC without window metadata, as browser fixtures
  // provide) is treated as the main window rather than failing startup.
  const current = (() => {
    try {
      return getCurrentWindow();
    } catch {
      return undefined;
    }
  })();
  return {
    label: current?.label ?? MAIN_WINDOW,
    layout: () => invoke("windows_layout"),
    listen: (listener) =>
      listen<unknown>(EVENT, (event) => listener(event.payload)),
    activation: (listener) =>
      listen<unknown>(ACTIVATE, (event) => listener(event.payload)),
    dropTarget: (listener) =>
      listen<unknown>(DROP_TARGET, (event) => listener(event.payload)),
    moveTab: (pageKey, destination) =>
      invoke("windows_move_tab", { pageKey, destination }),
    dropTab: (pageKey, x, y) => invoke("windows_drop_tab", { pageKey, x, y }),
    dragBegin: (tabKey, spec, x, y) =>
      invoke("windows_drag_begin", {
        tabKey,
        spec: JSON.stringify(spec),
        x,
        y,
      }),
    dragMove: (x, y) => invoke("windows_drag_move", { x, y }),
    dragEnd: () => invoke("windows_drag_end"),
    reset: () => invoke("windows_reset"),
    close: () => current?.close() ?? Promise.resolve(),
  };
}

/**
 * Coalesces pointer moves: at most one position IPC in flight, always the
 * latest point, and a move never overtakes its begin or outlives its end.
 */
export function createTabDrag(
  transport: Pick<WindowTransport, "dragBegin" | "dragMove" | "dragEnd">,
): TabDrag {
  let session = 0;
  let pending: { x: number; y: number } | undefined;
  let inflight: Promise<void> | undefined;
  const flush = (current: number) => {
    if (inflight || !pending || current !== session) return;
    const point = pending;
    pending = undefined;
    inflight = transport
      .dragMove(point.x, point.y)
      .catch(() => {})
      .then(() => {
        inflight = undefined;
        flush(current);
      });
  };
  return {
    begin(tabKey, spec, x, y) {
      const current = ++session;
      pending = undefined;
      inflight = transport
        .dragBegin(tabKey, spec, x, y)
        .catch(() => {})
        .then(() => {
          inflight = undefined;
          flush(current);
        });
    },
    move(x, y) {
      pending = { x, y };
      flush(session);
    },
    end() {
      session++;
      pending = undefined;
      const settle = inflight ?? Promise.resolve();
      void settle.then(() => transport.dragEnd()).catch(() => {});
    },
  };
}

export function createWindowHost(
  transport: WindowTransport | undefined = isTauri()
    ? tauriWindowTransport()
    : undefined,
): WindowHost {
  const listeners = new Set<() => void>();
  let snapshot: WindowSnapshot = Object.freeze({
    status: transport ? "loading" : "ready",
    layout: EMPTY,
    enabled: false,
  });
  let disposed = false;
  const stops: (() => void)[] = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const accept = (value: unknown) => {
    if (disposed) return;
    let layout: WindowLayout;
    try {
      layout = parseLayout(value);
    } catch {
      return; // Keep the last good layout; a malformed broadcast is not a reassignment.
    }
    snapshot = Object.freeze({ ...snapshot, status: "ready", layout });
    notify();
  };
  let seq = 0;
  const activate = (key: unknown) => {
    if (disposed || typeof key !== "string") return;
    snapshot = Object.freeze({ ...snapshot, activate: { key, seq: ++seq } });
    notify();
  };
  const hover = (payload: unknown) => {
    if (
      disposed ||
      !payload ||
      typeof payload !== "object" ||
      !("tab" in payload)
    )
      return;
    const tab = payload.tab;
    if (tab !== null && typeof tab !== "string") return;
    if ((snapshot.dropTarget?.tab ?? null) === tab) return;
    const { dropTarget: _, ...rest } = snapshot;
    snapshot = Object.freeze(
      tab === null ? rest : { ...rest, dropTarget: Object.freeze({ tab }) },
    );
    notify();
  };
  const track = (subscription: Promise<() => void>) =>
    void subscription
      .then((unlisten) => {
        if (disposed) unlisten();
        else stops.push(unlisten);
      })
      .catch(() => {});
  if (transport) {
    let live = false;
    // Register for changes before reading, so a move landing mid-fetch is never lost.
    track(
      transport.listen((layout) => {
        live = true;
        accept(layout);
      }),
    );
    track(transport.activation(activate));
    track(transport.dropTarget(hover));
    void transport
      .layout()
      .then((layout) => {
        if (!live) accept(layout);
      })
      .catch(() => {
        // Fail open as one window: main shows every page, a detached window shows its empty state.
        if (!live) accept(EMPTY);
      });
  }
  const label = transport?.label ?? MAIN_WINDOW;
  let enablers = 0;
  const setEnabled = (enabled: boolean) => {
    if (disposed || snapshot.enabled === enabled) return;
    snapshot = Object.freeze({ ...snapshot, enabled });
    notify();
  };
  return {
    label,
    isMain: label === MAIN_WINDOW,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enable() {
      enablers += 1;
      setEnabled(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        enablers -= 1;
        if (enablers > 0) return;
        setEnabled(false);
        // The plugin was switched off, not the app: gather every tab back into main.
        if (transport && !disposed)
          transport
            .reset()
            .then(accept)
            .catch(() => {});
      };
    },
    ...(transport
      ? {
          moveTab: async (pageKey: string, destination: WindowDestination) => {
            accept(await transport.moveTab(pageKey, destination));
          },
          dropTab: async (pageKey: string, x: number, y: number) => {
            accept(await transport.dropTab(pageKey, x, y));
          },
          drag: createTabDrag(transport),
        }
      : {}),
    ...(transport && label !== MAIN_WINDOW
      ? { close: () => transport.close() }
      : {}),
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}
