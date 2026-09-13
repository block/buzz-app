import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { BuzzLinkPreview } from "./BuzzLinkPreview";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";

// Shallow production-boundary checks. These invoke returned handlers and effect
// lifetimes; they do not claim browser layout, focus, or React StrictMode validation.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  ref: 0,
  states: [] as unknown[],
  index: 0,
  effects: [] as {
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }[],
  effect: 0,
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef(initial: unknown) {
    const index = hooks.ref++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
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
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
beforeEach(() =>
  Object.assign(hooks, {
    refs: [],
    ref: 0,
    states: [],
    index: 0,
    effects: [],
    effect: 0,
    pending: [],
  }),
);
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode) {
  return elements(node)
    .filter((e) => e.props.role === "status")
    .map((e) => e.props.children)
    .join("");
}
const root: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "reconciled body",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
function setup(snapshot: ThreadSnapshot) {
  Object.assign(hooks, {
    refs: [],
    ref: 0,
    states: [],
    index: 0,
    effects: [],
    effect: 0,
    pending: [],
  });
  const view = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies ThreadView;
  const session = {
    thread: vi.fn(() => view),
    profiles: {
      subscribe: () => () => {},
      snapshot: () => new Map(),
      ensure: vi.fn(async () => {}),
    },
    channels: {
      subscribeList: () => () => {},
      list: () => ({ channels: [{ id: "channel", name: "General" }] }),
    },
    media: () => undefined,
  } as unknown as RelaySession;
  hooks.ref = hooks.index = hooks.effect = 0;
  BuzzLinkPreview({
    session,
    channelId: "channel",
    messageId: root.id,
  });
  for (const effect of hooks.pending.splice(0)) effect();
  // Re-render the outer component now that the effect allocated the view, then
  // drive the inner PreviewContent with the shared hook registers.
  hooks.ref = hooks.index = hooks.effect = 0;
  const rendered = BuzzLinkPreview({
    session,
    channelId: "channel",
    messageId: root.id,
  }) as ReactElement;
  const child = elements(rendered).find((e) => typeof e.type === "function");
  if (!child) return rendered;
  hooks.ref = hooks.index = hooks.effect = 0;
  const render = child.type as (props: unknown) => ReactElement;
  const tree = render(child.props);
  for (const effect of hooks.pending.splice(0)) effect();
  return tree;
}
const base: ThreadSnapshot = {
  status: "idle",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: false,
  limited: false,
};
it("does not paint the seed root until the snapshot reconciles edits and deletions", () => {
  // A seeded but still-loading view exposes the raw root; a cached deletion or
  // edit is a different event that only folds in once the read reaches "ready".
  const seeded = setup({ ...base, status: "loading", root, canLoadMore: true });
  expect(text(seeded)).toBe("Loading message…");
  expect(elements(seeded).some((e) => e.type === "strong")).toBe(false);
  const idleSeed = setup({ ...base, status: "idle", root });
  expect(text(idleSeed)).toBe("Loading message…");
  const ready = setup({ ...base, status: "ready", root });
  expect(elements(ready).some((e) => e.type === "strong")).toBe(true);
});
it("reports terminal unavailability instead of loading forever", () => {
  // purge() on a denied or revoked channel publishes idle + an error string,
  // never status "error"; the card must still stop.
  const denied = setup({
    ...base,
    status: "idle",
    error: "This channel is no longer available.",
  });
  expect(text(denied)).toBe("Message preview unavailable.");
  const failed = setup({ ...base, status: "error", error: "read failed" });
  expect(text(failed)).toBe("Message preview unavailable.");
  const exhausted = setup({ ...base, status: "ready", root: undefined });
  expect(text(exhausted)).toBe("Message preview unavailable.");
});
it("keeps loading while a read is genuinely in flight", () => {
  const loading = setup({ ...base, status: "loading", canLoadMore: true });
  expect(text(loading)).toBe("Loading message…");
});
