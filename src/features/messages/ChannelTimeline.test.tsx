import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Virtualizer } from "virtua";
import { ChannelTimeline } from "./ChannelTimeline";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";

// Boundary test, not a browser renderer. Capture this production component's
// effects/refs and invoke its returned DOM handlers. Deliberately stale Virtua
// metrics reproduce the event ordering measured separately in Chromium/WebKit.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[],
  effects: [] as {
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }[],
  pending: [] as (() => void)[],
  ref: 0,
  state: 0,
  memo: 0,
  effect: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef(value: unknown) {
    const index = hooks.ref++;
    hooks.refs[index] ??= { current: value };
    return hooks.refs[index];
  },
  useState(initial: unknown) {
    const index = hooks.state++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
  useMemo(factory: () => unknown, deps: readonly unknown[]) {
    const index = hooks.memo++;
    const old = hooks.memos[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.memos[index] = { deps, value: factory() };
    return hooks.memos[index]?.value;
  },
  useEffect(create: () => (() => void) | undefined, deps: readonly unknown[]) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
  },
  useLayoutEffect(
    create: () => (() => void) | undefined,
    deps: readonly unknown[],
  ) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
    }
  },
}));
vi.mock("../relay/react", () => ({
  useRowProfiles: () => new Map(),
}));
afterEach(() => vi.unstubAllGlobals());

function setup({
  hasMore = false,
  loadingOlder = false,
  historyLimited = false,
  error = undefined as string | undefined,
  initial = undefined as unknown,
  mounted = [] as { id: string; y: number }[],
} = {}) {
  Object.assign(hooks, {
    refs: [],
    states: [],
    memos: [],
    effects: [],
    pending: [],
    ref: 0,
    state: 0,
    memo: 0,
    effect: 0,
  });
  const data = new Map<string, string>();
  if (initial !== undefined)
    data.set(
      'buzz-view.v1:["scope","scroll:channel"]',
      JSON.stringify(initial),
    );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const observers = new Map<() => void, Set<unknown>>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<unknown>();
      constructor(callback: () => void) {
        observers.set(callback, this.targets);
      }
      observe(target: unknown) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const resized = (target: unknown) => {
    for (const [callback, targets] of observers)
      if (targets.has(target)) callback();
  };
  const list = {};
  const element = {
    clientWidth: 1124,
    clientHeight: 668,
    scrollHeight: 3706,
    scrollTop: 2388,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => list,
    querySelectorAll: () =>
      mounted.map(({ id, y }) => ({
        dataset: { messageId: id },
        getBoundingClientRect: () => ({ top: y, bottom: y + 100 }),
        querySelector: () => ({
          getBoundingClientRect: () => ({ top: y + 32, bottom: y + 80 }),
        }),
      })),
  };
  const handle = {
    scrollOffset: 3038,
    scrollSize: 3649.5,
    viewportSize: 668,
    cache: [],
    scrollTo: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  const loadOlder = vi.fn();
  const queries = {
    channels: { loadOlder },
    profiles: {},
    // Geometry fixtures are read-only; reading behavior has its own boundary tests.
    unread: { sync: () => ({ capability: "unsupported" }) },
    media: () => undefined,
  } as unknown as RelaySession;
  let rows = [
    { id: "first", authorId: "author" },
    { id: "last", authorId: "author" },
  ] as ChannelMessage[];
  type Section = ReactElement<{
    ref: { current: unknown };
    children: unknown[];
    onScroll: (event: unknown) => void;
    onWheel: () => void;
  }>;
  let section: Section;
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };
  function render(runFrames = true) {
    hooks.ref = hooks.state = hooks.memo = hooks.effect = 0;
    const scoped = ChannelTimeline({
      channelId: "channel",
      scope: "scope",
      queries,
      window: {
        channelId: "channel",
        status: "ready",
        error,
        rows,
        hasMore,
        loadingOlder,
        historyLimited,
      },
      onOpenLink: () => false,
    });
    section = (scoped.type as (props: typeof scoped.props) => Section)(
      scoped.props,
    );
    section.props.ref.current = element;
    const virtualizer = section.props.children.find(
      (child) =>
        !!child &&
        typeof child === "object" &&
        "type" in child &&
        child.type === Virtualizer,
    ) as ReactElement<{ ref: { current: unknown } }>;
    if (virtualizer) virtualizer.props.ref.current = handle;
    for (const effect of hooks.pending.splice(0)) effect();
    if (runFrames) flush();
  }
  render(); // Mount/measure through the production layout effect.
  render(); // Apply its setWidth before attaching the virtualizer.
  return {
    element,
    handle,
    loadOlder,
    flush,
    resize(runFrames = true) {
      resized(element);
      render(runFrames);
    },
    measureRows(runFrames = true) {
      resized(list);
      if (runFrames) flush();
    },
    gesture() {
      section.props.onWheel();
    },
    scroll(user = true) {
      resized(element);
      render();
      if (user) section.props.onWheel();
      section.props.onScroll({ currentTarget: element });
    },
    edit(runFrames = true) {
      rows = rows.map((row) =>
        row.id === "last" ? { ...row, content: "Longer edited message" } : row,
      );
      render(runFrames);
    },
    prepend() {
      rows = [{ id: "older", authorId: "author" } as ChannelMessage, ...rows];
      render();
    },
    append() {
      rows = [
        ...rows,
        { id: "appended", authorId: "author" } as ChannelMessage,
      ];
      render();
    },
    unmount() {
      for (const effect of hooks.effects) effect.cleanup?.();
    },
    saved() {
      const raw = data.get('buzz-view.v1:["scope","scroll:channel"]');
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

it("persists the event target's reading position at real component cleanup, not the previous virtualizer offset", () => {
  const h = setup();
  h.scroll();
  h.unmount();
  expect(h.saved()).toEqual({ offset: 2388, bottom: false });
});
it("a bottom-position event persists bottom intent even when the virtualizer still reports zero", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll(false);
  h.unmount();
  expect(h.saved()).toEqual({ offset: 3038, bottom: true });
});
it("an append follows the actual bottom position, not stale virtualizer position", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(2, { align: "end" });
  h.unmount();
});
it("an append does not steal a reading position when virtualizer still reports bottom", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("loads older rows at the current DOM threshold despite a stale far-away virtualizer offset", () => {
  const h = setup({ hasMore: true });
  h.handle.scrollOffset = 3300;
  h.scroll();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});
it("does not load older rows when only the old virtualizer position is inside the threshold", () => {
  const h = setup({ hasMore: true });
  h.element.scrollHeight = 8000;
  h.element.scrollTop = 3300;
  h.handle.scrollOffset = 2388;
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { hasMore: false },
  { hasMore: true, loadingOlder: true },
  { hasMore: true, historyLimited: true },
  { hasMore: true, error: "Relay requests paused" },
])("keeps the existing paging guard %j", (options) => {
  const h = setup(options);
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it("programmatic scroll does not page before a user gesture", () => {
  const h = setup({ hasMore: true });
  h.scroll(false);
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});

it.each([
  { height: 668, gap: 79, bottom: true },
  { height: 668, gap: 80, bottom: false },
  { height: 1000, gap: 79, bottom: true },
  { height: 1000, gap: 80, bottom: false },
])(
  "uses current geometry for the strict bottom threshold: $height/$gap",
  ({ height, gap, bottom }) => {
    const h = setup();
    h.element.clientHeight = height;
    h.element.scrollTop = h.element.scrollHeight - h.element.clientHeight - gap;
    h.scroll();
    h.unmount();
    expect(h.saved()).toEqual({ offset: h.element.scrollTop, bottom });
  },
);
it.each([
  { height: 668, offset: 2999, calls: 1 },
  { height: 668, offset: 3000, calls: 0 },
  { height: 1000, offset: 3999, calls: 1 },
  { height: 1000, offset: 4000, calls: 0 },
])(
  "uses current viewport for the strict max(3000, 4×height) paging boundary: $height/$offset",
  ({ height, offset, calls }) => {
    const h = setup({ hasMore: true });
    Object.assign(h.element, {
      clientHeight: height,
      scrollHeight: 8000,
      scrollTop: offset,
    });
    h.scroll();
    expect(h.loadOlder).toHaveBeenCalledTimes(calls);
    h.unmount();
  },
);

it("restores a saved message anchor instead of an unreachable cold pixel offset", () => {
  const h = setup({
    initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { offset: 1234, bottom: false },
  { offset: 1234, bottom: false, anchor: { id: "missing", y: 42 } },
])(
  "keeps an offset fallback for legacy positions and an anchor outside retained history: %j",
  (initial) => {
    const h = setup({ initial });
    expect(h.handle.scrollTo).toHaveBeenCalledWith(1234);
    h.unmount();
  },
);
it("captures the mounted message at cleanup and restores that anchor after resize", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved()).toEqual({
    offset: 2388,
    bottom: false,
    anchor: { id: "last", y: 42 },
  });
});
it("a gesture after resize cancels queued restoration instead of fighting the reader", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a same-ID content update follows bottom without waiting for another message", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.unmount();
});
it("same-ID content updates leave an above-bottom reader to virtualizer anchoring", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending history does not become a follow-to-bottom command", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.prepend();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("a new gesture wins over content-follow scheduled by an edit", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a user gesture at a restored top pages without needing a DOM scroll event", () => {
  const h = setup({ hasMore: true, initial: { offset: 0, bottom: false } });
  h.element.scrollTop = 0;
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.gesture();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});

it.each([
  { hasMore: false },
  { hasMore: true, loadingOlder: true },
  { hasMore: true, historyLimited: true },
  { hasMore: true, error: "Relay requests paused" },
])("a boundary gesture preserves the history guard %j", (options) => {
  const h = setup(options);
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});

it("keeps bottom restoration through repeated late list measurements without another viewport resize", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  // The viewport and rows are unchanged; only Virtua's measured list reflows.
  h.measureRows();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledTimes(2);
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  h.unmount();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});
it.each([false, true])(
  "a new gesture cancels late bottom reflow, including queued=%s",
  (queued) => {
    const h = setup();
    h.element.scrollTop = 3038;
    h.scroll();
    h.element.clientWidth = 650;
    h.resize();
    h.handle.scrollToIndex.mockClear();
    if (queued) h.measureRows(false);
    h.gesture();
    if (queued) h.flush();
    else h.measureRows();
    expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
  },
);
it("late measurements do not convert reading-anchor restoration to bottom follow", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending retires the preceding bottom-reflow observer and its queued frame", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.prepend();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("ordinary initial bottom and append commands do not install resize-follow observation", () => {
  const h = setup();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
