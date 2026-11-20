import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { Navigation } from "../navigation/controller";
import { type OpenTarget, targetKey } from "../navigation/targets";
import { DetailsSheet } from "./DetailsSheet";
import {
  InlineThreadIntro,
  type InlineThreadIntroStep,
  inlineThreadIntroSeen,
  markInlineThreadIntroSeen,
} from "./InlineThreadIntro";
import {
  type ComposerHandle,
  ComposerScope,
  type ComposerName,
  channelComposer,
  composerChannel,
  composerHost,
  createComposerHandle,
  overlayHost,
  threadComposer,
  useComposerForm,
} from "./composer-overlay";
import styles from "./Messages.module.css";

/** What a row opens: a thread, a panel such as a pull request, a details
 * message or a diff. It says what to read, never how to draw it: the
 * conversation that owns the composer draws it, so its links, edits and
 * message actions work. Media is a viewer of its own, not one of these. */
export type InlineTarget =
  | Readonly<{
      kind: "thread";
      channelId: string;
      rootId: string;
      /** The message to reveal, the root or a reply in it. */
      messageId: string;
      /** Opened to reply: its reply box takes focus. */
      reply?: boolean | undefined;
    }>
  | Readonly<{
      kind: "panel";
      channelId: string;
      rootId?: string | undefined;
      title: string;
      /** The workspace's own description of the panel, which it draws. */
      opening: unknown;
    }>
  | Readonly<{ kind: "details" | "diff"; messageId: string }>;

/** What a thread read inline hands its tab: the reply it reads at, unless it
 * follows the latest, and the reply it is answering. */
export type ThreadHandoff = Readonly<{
  anchor?: string | undefined;
  replyParent?: string | undefined;
}>;

/** One request to open `target`, from the row whose composer it reads over. */
export type InlineRequest = Readonly<{
  target: InlineTarget;
  /** The composer of the scope it was opened from. */
  composer: ComposerHandle | undefined;
  /** Where focus returns when it closes. */
  trigger: HTMLElement | null;
  /** It already has a tab, which shows instead. */
  hasTab?: boolean | undefined;
  /** Shows it in a tab: without an inline place, and from its Open as tab,
   * where a thread hands over where it was read and its reply target. */
  openAsTab?: ((handoff?: ThreadHandoff) => void) | undefined;
}>;

/** Something open: inline over its composer, or in a dialog when there is
 * nowhere inline to read it and no tab to show it in. */
export type InlineEntry = InlineRequest & {
  placement: "inline" | "dialog";
};
/** One open entry. `key` is this opening; `open` false while it leaves. */
export type Placed = InlineEntry & {
  key: number;
  open: boolean;
  focus: { current: HTMLElement | null };
  /** This opening, the same when history shows it again under a new key. */
  opening?: number | undefined;
  /** The history visits this opening made, oldest first: its open, then each
   * page a panel moved to in place. Closing it with ✕ retires them. */
  visits?: readonly string[] | undefined;
  /** Reopened by history while its composer comes back, as when its
   * conversation mounts again: it waits, unshown, for a composer of the same
   * name. */
  waiting?: boolean | undefined;
  /** Waits only while a tab still holds its composer, and not for long:
   * its composer is a thread tab's, which may not come back. */
  briefly?: boolean | undefined;
};

/** What it reads: opening the same thing again replaces it. */
export function entryId(target: InlineTarget) {
  switch (target.kind) {
    case "thread":
      return threadComposer(target.channelId, target.rootId);
    case "panel":
      return `panel:${target.channelId}:${target.rootId ?? ""}`;
    default:
      return `${target.kind}:${target.messageId}`;
  }
}
/** The composer its content holds, as a thread's reply box. What opens over
 * that composer opens on this entry, and closes with it. */
const provides = ({ target }: InlineEntry) =>
  target.kind === "thread"
    ? threadComposer(target.channelId, target.rootId)
    : undefined;
/** How each kind behaves over its composer. */
export const BEHAVIOR = {
  // Holds its own composer and places focus itself.
  thread: { closeLabel: "Close thread", containsComposer: true },
  // Owns its scrollport and shows no composer.
  panel: { closeLabel: "Close", readerOnly: true },
  // A send from its composer closes it.
  details: { closeLabel: "Close details", closesOnSend: true },
  diff: { closeLabel: "Close diff", readerOnly: true },
} as const satisfies Record<
  InlineTarget["kind"],
  {
    closeLabel: string;
    containsComposer?: boolean;
    readerOnly?: boolean;
    closesOnSend?: boolean;
  }
>;
const behavior = (
  entry: InlineEntry,
): (typeof BEHAVIOR)[keyof typeof BEHAVIOR] &
  Partial<{
    containsComposer: boolean;
    readerOnly: boolean;
    closesOnSend: boolean;
  }> => BEHAVIOR[entry.target.kind];

/** Everything open on the entries in `ids`, including them. */
function withStack(list: readonly Placed[], ids: ReadonlySet<string>) {
  const closing = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of list) {
      const id = entryId(item.target);
      if (closing.has(id) || !item.open) continue;
      const below = list.find(
        (other) =>
          other.open &&
          closing.has(entryId(other.target)) &&
          provides(other) === item.composer?.name,
      );
      if (below) {
        closing.add(id);
        grew = true;
      }
    }
  }
  return closing;
}
const closeAll = (list: readonly Placed[], ids: ReadonlySet<string>) => {
  if (!ids.size) return list as Placed[];
  const closing = withStack(list, ids);
  return list.map((item) =>
    closing.has(entryId(item.target)) && item.open
      ? { ...item, open: false }
      : item,
  );
};
const openIds = (list: readonly Placed[], test: (item: Placed) => boolean) =>
  new Set(
    list
      .filter((item) => item.open && test(item))
      .map((item) => entryId(item.target)),
  );

/** Where a request opens: over its composer when Inline is on, the composer is
 * on screen and it has no tab; otherwise in its tab; otherwise a dialog. */
export function placement(
  request: InlineRequest,
  inline: (composer: ComposerHandle | undefined) => boolean,
): "inline" | "dialog" | "tab" {
  if (!request.hasTab && inline(request.composer)) return "inline";
  return request.openAsTab ? "tab" : "dialog";
}

/** Opening replaces whatever is over the same composer, and anything open on
 * it. Entries over other composers stay. */
export function opened(
  list: readonly Placed[],
  entry: InlineEntry,
  key: number,
  visits?: readonly string[],
): Placed[] {
  const id = entryId(entry.target);
  const replaced = openIds(
    list,
    (item) =>
      entryId(item.target) === id ||
      (item.placement === entry.placement && item.composer === entry.composer),
  );
  return [
    ...closeAll(list, replaced),
    {
      ...entry,
      key,
      open: true,
      focus: { current: entry.trigger },
      opening: key,
      ...(visits?.length ? { visits } : {}),
    },
  ];
}
/** Closing an entry closes everything open on it. */
export const closed = (list: readonly Placed[], id: string) =>
  closeAll(list, new Set([id]));
/** What a send from `composer` closes: the details over it. */
export const closedOnSend = (
  list: readonly Placed[],
  composer: ComposerHandle,
) =>
  openIds(
    list,
    (item) => item.composer === composer && !!behavior(item).closesOnSend,
  );
/** A composer that is gone for good, as a closed tab's, closes what is over
 * it. */
export const composerGone = (
  list: readonly Placed[],
  composer: ComposerHandle,
) =>
  closeAll(
    list,
    openIds(
      list,
      (item) => item.placement === "inline" && item.composer === composer,
    ),
  );
/** Moving an entry to its tab takes it out of the list, and closes what is
 * open on it: its tab holds a composer of its own. */
export function movedToTab(list: readonly Placed[], id: string) {
  const moving = list.find((item) => item.open && entryId(item.target) === id);
  if (!moving) return list as Placed[];
  return closed(list, id).filter((item) => item.key !== moving.key);
}
/** Leaving a channel closes what is over its composers, except what `stays`,
 * as over another channel's side tab that is still open. */
export function left(
  list: readonly Placed[],
  channelId: string | undefined,
  stays: (item: Placed) => boolean = () => false,
) {
  const keeps = (item: Placed) => channelOf(item) === channelId || stays(item);
  return list.every(keeps) ? (list as Placed[]) : list.filter(keeps);
}
const channelOf = (item: Placed) => composerChannel(item.composer?.name ?? "");
/** Navigating inside an open entry replaces what it reads, in place. */
export const updated = (
  list: readonly Placed[],
  id: string,
  target: InlineTarget,
  visit?: string,
) =>
  list.map((item) =>
    item.open && entryId(item.target) === id
      ? {
          ...item,
          target,
          ...(visit && !item.visits?.includes(visit)
            ? { visits: [...(item.visits ?? []), visit] }
            : {}),
        }
      : item,
  );
/** The visits that closing `id` with ✕ retires: its own and those of
 * everything open on it, which closes with it. */
export function dismissed(list: readonly Placed[], id: string) {
  const closing = withStack(list, new Set([id]));
  const items = list.filter(
    (item) => item.open && closing.has(entryId(item.target)),
  );
  return {
    visits: items.flatMap((item) => item.visits ?? []),
    openings: new Set(items.map((item) => item.opening ?? item.key)),
  };
}
/**
 * Back or Forward to a visit shows what was open at it. An opening still on
 * screen stays mounted, reading what it read then; the rest close, and what
 * was open then and is not now opens again, through `place`, which decides
 * where it can open now (or drops it, as one moved to its tab).
 */
export function restored(
  list: readonly Placed[],
  picture: readonly Placed[],
  place: (item: Placed) => Placed | undefined,
  key: () => number,
): Placed[] {
  const opening = (item: Placed) => item.opening ?? item.key;
  const wanted = new Map(picture.map((item) => [opening(item), item]));
  const next = list.map((item) => {
    const then = wanted.get(opening(item));
    if (!item.open) return item;
    if (!then) return { ...item, open: false };
    wanted.delete(opening(item));
    return then.target === item.target && then.visits === item.visits
      ? item
      : { ...item, target: then.target, visits: then.visits };
  });
  for (const item of wanted.values()) {
    const placed = place(item);
    if (placed)
      next.push({
        ...placed,
        key: key(),
        opening: opening(item),
        open: true,
        focus: { current: null },
      });
  }
  return next;
}
/** A visit not seen here, as a link or a typed address makes, shows what it
 * names: the rest closes, keeping what the named entries are open on. */
export function arrived(
  list: readonly Placed[],
  names: (item: Placed) => boolean,
) {
  const keep = new Set(
    list.filter((item) => item.open && names(item)).map((item) => item.target),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of list) {
      if (!item.open || keep.has(item.target)) continue;
      const name = provides(item);
      if (
        name &&
        list.some(
          (other) => keep.has(other.target) && other.composer?.name === name,
        )
      ) {
        keep.add(item.target);
        grew = true;
      }
    }
  }
  return closeAll(
    list,
    openIds(list, (item) => !keep.has(item.target)),
  );
}
/** An entry that finished leaving. */
export const removed = (list: readonly Placed[], key: number) =>
  list.filter((item) => item.key !== key);

type Store = Readonly<{
  get(): Placed[];
  set(change: (list: Placed[]) => Placed[]): void;
  subscribe(listener: () => void): () => void;
}>;
export function createStore(): Store {
  let list: Placed[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => list,
    set: (change) => {
      const next = change(list);
      if (next === list) return;
      list = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Draws a panel entry; `navigate` replaces what it reads in place. */
export type PanelRenderer = (
  target: Extract<InlineTarget, { kind: "panel" }>,
  controls: Readonly<{ close(): void; navigate(next: InlineTarget): void }>,
) => ReactNode;

/** How a workspace's entries take part in navigation history. Opening one is
 * a visit to its address; Back and Forward show what was open at a visit, and
 * ✕ retires the visits of what it closes. */
export type InlineHistory = Readonly<{
  navigator: Navigation;
  /** The address of what `entry` reads, from the current one; without an
   * entry, the conversation's own address beneath them. */
  address(
    entry: InlineEntry | undefined,
    current: OpenTarget,
  ): OpenTarget | undefined;
}>;

export type InlineOpener = Readonly<{
  /** The one place every row opens what it reads. */
  open(request: InlineRequest): void;
  /** Closes what reads `id`; see entryId. */
  close(id: string): void;
  /** Closes what reads `id` for good, as its ✕ does: history retires its
   * visits, so Forward does not bring it back. */
  dismiss(id: string): void;
  /** Moves what reads `id` to its tab, which shows it from then on: no visit
   * shows it inline again. Its address stays, so this adds no visit. */
  moveToTab(id: string): void;
  /** A panel moved to another page in place: a visit of its own. */
  navigate(id: string, target: InlineTarget): void;
  /** Visits an opening here made, which the workspace presents as its plain
   * conversation: what is open over the composers already shows them. */
  presents(visit: string): boolean;
  /** A visit arrived at a reader's address, as after a reload: the reader's
   * row opens it once it is on screen. */
  requestReader(target: InlineTarget | undefined): void;
  /** The reader a visit asks for, by entryId, until its row takes it. */
  requestedReader: Readonly<{
    get(): string | undefined;
    subscribe(listener: () => void): () => void;
    take(id: string): boolean;
  }>;
  /** Ties the entries to navigation history; returns its release. */
  attachHistory(history: InlineHistory): () => void;
  /** Composers with an outlet here, by name, so Back can find one again after
   * its conversation mounts anew. Returns the release. */
  outlet(handle: ComposerHandle): () => void;
  sent(composer: ComposerHandle): void;
  composerGone(composer: ComposerHandle): void;
  /** The page has drawn `channelId`: what waits for a thread tab's composer
   * that no tab `holds` stops waiting. */
  settle(
    channelId: string | undefined,
    holds: (name: ComposerName) => boolean,
  ): void;
  /** A tab closing for good takes what was ever open over its composer, at
   * any visit, that has nowhere else to open: returns their visits, for the
   * tab's dismissal to retire. */
  retire(name: ComposerName): string[];
  store: Store;
  /** The workspace draws its panels. */
  renderPanel: PanelRenderer;
}>;
/** Stable: rows that open entries never re-render as the list changes. */
export const InlineContainers = createContext<InlineOpener | undefined>(
  undefined,
);

export function createOpener(
  store: Store,
  renderPanel: { current: PanelRenderer | undefined },
  inline = true,
): InlineOpener {
  let sequence = 0;
  const shows = (composer: ComposerHandle | undefined) =>
    inline && !!overlayHost(composer);
  // History: what was open at each visit, the visit the list now shows, and
  // the visits openings here made.
  let history: InlineHistory | undefined;
  let shown: string | undefined;
  let pushing = false;
  let dismissing = false;
  const pictures = new Map<string, Placed[]>();
  const made = new Set<string>();
  const outlets = new Map<ComposerName, Set<ComposerHandle>>();
  const record = () => {
    if (shown)
      pictures.set(
        shown,
        store.get().filter((item) => item.open),
      );
  };
  // An opening leaves every picture. Closed, it takes what each picture had
  // open on it too; moved to its tab, that stays, to open the usual way.
  const forget = (openings: ReadonlySet<number>, stack = true) => {
    for (const [id, picture] of pictures) {
      const named = new Set(
        picture
          .filter((item) => openings.has(item.opening ?? item.key))
          .map((item) => entryId(item.target)),
      );
      const gone = stack ? withStack(picture, named) : named;
      pictures.set(
        id,
        picture.filter((item) => !gone.has(entryId(item.target))),
      );
    }
  };
  let requested: string | undefined;
  const readerListeners = new Set<() => void>();
  const request = (id: string | undefined) => {
    if (id === requested) return;
    requested = id;
    for (const listener of readerListeners) listener();
  };
  store.subscribe(record);
  /** The visit of `entry`: a new one for its address, or the current visit
   * when that is already its address. */
  const visit = (entry: InlineEntry): string | undefined => {
    if (!history) return undefined;
    const { navigator } = history;
    const current = navigator.snapshot().entry;
    const address = history.address(entry, current.target);
    if (!address) return undefined;
    if (targetKey(address) === targetKey(current.target)) return current.id;
    pushing = true;
    try {
      void navigator.open(address, { focus: "preserve", sidebar: "preserve" });
    } finally {
      pushing = false;
    }
    const next = navigator.snapshot().entry.id;
    if (next === current.id) return undefined;
    made.add(next);
    shown = next;
    return next;
  };
  const live = (name: ComposerName | undefined) =>
    [...(name ? (outlets.get(name) ?? []) : [])].find(shows);
  /** Where a remembered entry opens now: over its composer, or another
   * composer of its name; waiting for one that is on its way back; else as
   * any request without a composer opens. */
  const place = (item: Placed, picture: readonly Placed[]) => {
    if (item.placement === "inline") {
      if (shows(item.composer)) return { ...item, waiting: false };
      const again = live(item.composer?.name);
      if (again) return { ...item, composer: again, waiting: false };
      const name = item.composer?.name;
      const target = history?.navigator.snapshot().entry.target;
      const returning =
        !!name &&
        (picture.some((other) => provides(other) === name) ||
          name === channelComposerOf(target));
      if (returning) return { ...item, waiting: true };
      // With nowhere else to open, it waits for its thread's tab, as another
      // channel's side tab, while that tab lasts: see `settle`.
      if (name && !item.openAsTab)
        return { ...item, waiting: true, briefly: true };
    }
    return elsewhere(item);
  };
  /** Where an entry opens without its composer: its tab, else a dialog. */
  const elsewhere = (item: Placed) => {
    if (item.openAsTab) {
      queueMicrotask(() => item.openAsTab?.());
      return undefined;
    }
    return {
      ...item,
      placement: "dialog" as const,
      waiting: false,
      briefly: false,
    };
  };
  // What waits for a thread tab gives up when no tab holds its composer, or
  // when its composer has not come back soon: a tab can stay without one, as
  // over an archived channel. It then opens as it would without a composer,
  // in its own channel; elsewhere it closes, as leaving that channel does.
  let drawn: string | undefined;
  const brief = (item: Placed) => item.open && !!item.waiting && !!item.briefly;
  const giveUp = (gives: (item: Placed) => boolean) =>
    store.set((items) =>
      items.some((item) => brief(item) && gives(item))
        ? items.flatMap((item) => {
            if (!(brief(item) && gives(item))) return [item];
            if (channelOf(item) !== drawn) return [];
            const placed = elsewhere(item);
            if (!placed) return [];
            // It opens over its row as now mounted, which a return remounts.
            const name = placed.composer?.name;
            const row = [...((name && outlets.get(name)) || [])].at(-1);
            return [row ? { ...placed, composer: row } : placed];
          })
        : items,
    );
  const arrive = () => {
    if (!history || pushing) return;
    const snapshot = history.navigator.snapshot();
    const retained = snapshot.retainedVisits;
    if (retained)
      for (const id of [...pictures.keys()])
        if (!retained.includes(id)) {
          pictures.delete(id);
          made.delete(id);
        }
    const id = snapshot.entry.id;
    if (id === shown) return;
    shown = id;
    const picture = pictures.get(id);
    // A dismissal's return keeps what is open.
    if (dismissing) {
      record();
      return;
    }
    // A visit not seen here yet keeps only what its address names.
    if (!picture) {
      const { target } = snapshot.entry;
      const key = targetKey(target);
      const { address } = history;
      store.set((items) =>
        arrived(items, (item) => {
          const at = address(item, target);
          return !!at && targetKey(at) === key;
        }),
      );
      record();
      return;
    }
    store.set((items) =>
      restored(
        items,
        picture,
        (item) => place(item, picture),
        () => ++sequence,
      ),
    );
    // Each restore waits its own time: keyed by the item it placed, not by
    // the opening, which an earlier restore's timer still names.
    const waits = new Set(
      store
        .get()
        .filter(brief)
        .map((item) => item.key),
    );
    if (waits.size)
      setTimeout(() => giveUp((item) => waits.has(item.key)), BRIEF_WAIT_MS);
  };
  /** Closes what reads `id` for good; see InlineOpener.dismiss. */
  const dismiss = (id: string) => {
    const { visits, openings } = dismissed(store.get(), id);
    store.set((items) => closed(items, id));
    // No visit shows it again, Back included.
    forget(openings);
    if (!history || !visits.length) return;
    const { navigator } = history;
    const current = navigator.snapshot().entry;
    // What remains returns to the address of the newest thing still open,
    // else to the conversation itself.
    const top = store
      .get()
      .filter((item) => item.open && item.visits?.length)
      .at(-1);
    const fallback =
      (top && history.address(top, current.target)) ??
      history.address(undefined, current.target);
    if (!fallback) return;
    dismissing = true;
    try {
      navigator.dismiss(visits, fallback);
    } finally {
      dismissing = false;
    }
  };
  return {
    open: (request) => {
      const where = placement(request, shows);
      if (where === "tab") {
        request.openAsTab?.();
        return;
      }
      const entry = { ...request, placement: where };
      const at = visit(entry);
      store.set((items) =>
        opened(items, entry, ++sequence, at ? [at] : undefined),
      );
    },
    close: (id) => store.set((items) => closed(items, id)),
    moveToTab: (id) => {
      const moving = store
        .get()
        .find((item) => item.open && entryId(item.target) === id);
      store.set((items) => movedToTab(items, id));
      if (moving) forget(new Set([moving.opening ?? moving.key]), false);
    },
    dismiss,
    navigate: (id, target) => {
      const item = store
        .get()
        .find((entry) => entry.open && entryId(entry.target) === id);
      const at = item && visit({ ...item, target });
      store.set((items) => updated(items, id, target, at));
    },
    presents: (id) => made.has(id),
    // A reader already open stays as it is.
    requestReader: (target) =>
      request(
        target &&
          !store
            .get()
            .some(
              (item) => item.open && entryId(item.target) === entryId(target),
            )
          ? entryId(target)
          : undefined,
      ),
    requestedReader: {
      get: () => requested,
      subscribe: (listener) => {
        readerListeners.add(listener);
        return () => {
          readerListeners.delete(listener);
        };
      },
      take: (id) => {
        if (requested !== id) return false;
        request(undefined);
        return true;
      },
    },
    attachHistory: (next) => {
      history = next;
      shown = next.navigator.snapshot().entry.id;
      record();
      const stop = next.navigator.subscribe(arrive);
      return () => {
        stop();
        if (history === next) history = undefined;
      };
    },
    outlet: (handle) => {
      const named = outlets.get(handle.name) ?? new Set();
      named.add(handle);
      outlets.set(handle.name, named);
      // An entry waiting for a composer of this name opens over it; one
      // waiting for a thread tab, once the tab's reply box is there.
      const binds = (item: Placed) =>
        !!item.waiting &&
        item.composer?.name === handle.name &&
        (!item.briefly || shows(handle));
      const rebind = () =>
        store.set((items) =>
          items.some(binds)
            ? items.map((item) =>
                binds(item)
                  ? {
                      ...item,
                      composer: handle,
                      waiting: false,
                      briefly: false,
                    }
                  : item,
              )
            : items,
        );
      rebind();
      const stop = handle.subscribe(rebind);
      return () => {
        stop();
        named.delete(handle);
        if (!named.size) outlets.delete(handle.name);
      };
    },
    // A send closes the details over its composer as ✕ does, visits and all.
    sent: (composer) => {
      for (const id of closedOnSend(store.get(), composer))
        if (
          store.get().some((item) => item.open && entryId(item.target) === id)
        )
          dismiss(id);
    },
    composerGone: (composer) =>
      store.set((items) => composerGone(items, composer)),
    settle: (channelId, holds) => {
      drawn = channelId;
      giveUp((item) => !holds(item.composer?.name as ComposerName));
    },
    retire: (name) => {
      const over = (list: readonly Placed[]) => {
        const ids = withStack(
          list,
          openIds(list, (item) => item.composer?.name === name),
        );
        return list.filter(
          (item) =>
            item.open &&
            ids.has(entryId(item.target)) &&
            // A reader with its own tab can still open after its thread's tab closes.
            !item.openAsTab,
        );
      };
      const items = [store.get(), ...pictures.values()].flatMap(over);
      store.set((list) =>
        closeAll(
          list,
          openIds(list, (item) => item.composer?.name === name),
        ),
      );
      forget(new Set(items.map((item) => item.opening ?? item.key)));
      return [...new Set(items.flatMap((item) => item.visits ?? []))];
    },
    store,
    renderPanel: (target, controls) => renderPanel.current?.(target, controls),
  };
}

const channelComposerOf = (target: OpenTarget | undefined) =>
  target?.kind === "conversation"
    ? channelComposer(target.channelId)
    : undefined;

const noVisits = () => () => {};
/** How long a reader waits for its thread tab's reply box. */
const BRIEF_WAIT_MS = 5000;

/** The opener rows use: their workspace's, or one of their own that opens
 * readers in dialogs where there is no workspace, as in search previews. */
export function useInlineContainers() {
  const workspace = useContext(InlineContainers);
  const [own] = useState(() =>
    workspace
      ? undefined
      : createOpener(createStore(), { current: undefined }, false),
  );
  return {
    opener: (workspace ?? own) as InlineOpener,
    dialogs: own && <ReaderDialogs opener={own} />,
  };
}

/** One conversation workspace's entries. Composers draw what is over them;
 * `dialogs` draws what opened without a composer. Leaving `channelId` closes
 * them. A workspace that reads nothing inline (`inline` false) opens each
 * request in its tab, else a dialog. */
export function useInlineContainerList(
  channelId: string | undefined,
  renderPanel?: PanelRenderer,
  history?: InlineHistory,
  inline = true,
  /** Whether a thread tab of the drawn conversation holds a composer. */
  holds?: { current: ((name: ComposerName) => boolean) | undefined },
) {
  const [store] = useState(createStore);
  const panels = useRef(renderPanel);
  useLayoutEffect(() => {
    panels.current = renderPanel;
  });
  const [opener] = useState(() => createOpener(store, panels, inline));
  const navigator = history?.navigator;
  const address = useRef(history?.address);
  address.current = history?.address;
  useLayoutEffect(
    () =>
      navigator
        ? opener.attachHistory({
            navigator,
            address: (entry, current) => address.current?.(entry, current),
          })
        : undefined,
    [opener, navigator],
  );
  // Once the visit's conversation is drawn, its thread tabs say which
  // composers come back. This runs before leaving's cleanup below, which
  // would close what still waits.
  useSyncExternalStore(
    navigator?.subscribe ?? noVisits,
    () => navigator?.snapshot().entry.id,
    () => navigator?.snapshot().entry.id,
  );
  useEffect(() => {
    const target = navigator?.snapshot().entry.target;
    if (target?.kind === "conversation" && target.channelId === channelId)
      opener.settle(channelId, (name) => !!holds?.current?.(name));
  });
  useEffect(() => {
    store.set((items) =>
      left(
        items,
        channelId,
        (item) => !!item.waiting || (inline && !!overlayHost(item.composer)),
      ),
    );
  }, [store, channelId, inline]);
  // Closes them all, as when their conversation is hidden.
  const closeEverything = useCallback(
    () => store.set((items) => left(items, undefined)),
    [store],
  );
  return {
    opener,
    closeAll: closeEverything,
    dialogs: <ReaderDialogs opener={opener} />,
  };
}

// Readers draw their own message into the place their entry opened, through a
// portal, so the row's conversation renders them live.
type Slot = Readonly<{
  title: HTMLElement | null;
  leading: HTMLElement | null;
  description: HTMLElement | null;
  body: HTMLElement | null;
}>;
const slots = new Map<string, Slot>();
const slotListeners = new Set<() => void>();
const slotKey = (composer: ComposerHandle | undefined, id: string) =>
  `${composer?.id ?? ""}\n${id}`;
function setSlot(key: string, slot: Slot | undefined) {
  if (slot) slots.set(key, slot);
  else slots.delete(key);
  for (const listener of slotListeners) listener();
}
function subscribeSlots(listener: () => void) {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}
// The rows on screen that draw a reader. A reader shows only while its row
// can draw it, so a row that is gone (a deleted message, a closed thread)
// never leaves an empty sheet.
const rows = new Map<string, number>();
function setRow(key: string, change: 1 | -1) {
  const count = (rows.get(key) ?? 0) + change;
  if (count > 0) rows.set(key, count);
  else rows.delete(key);
  for (const listener of slotListeners) listener();
}
function useRowPresent(entry: Placed) {
  const key = slotKey(entry.composer, entryId(entry.target));
  return useSyncExternalStore(
    subscribeSlots,
    () => rows.has(key),
    () => rows.has(key),
  );
}
/** Where a reader opened from `composer` draws itself, while it is open. */
export function useReaderSlot(
  composer: ComposerHandle | undefined,
  target: InlineTarget,
) {
  const key = slotKey(composer, entryId(target));
  useEffect(() => {
    setRow(key, 1);
    return () => setRow(key, -1);
  }, [key]);
  return useSyncExternalStore(
    subscribeSlots,
    () => slots.get(key),
    () => slots.get(key),
  );
}

/** Opens this row's reader when a visit to its address asks for it, as after
 * a reload, once the row is on screen. */
export function useRequestedReader(
  opener: InlineOpener,
  target: InlineTarget,
  show: () => void,
) {
  const id = entryId(target);
  const { requestedReader } = opener;
  const wanted = useSyncExternalStore(
    requestedReader.subscribe,
    () => requestedReader.get() === id,
    () => false,
  );
  const open = useRef(show);
  open.current = show;
  useEffect(() => {
    if (wanted && requestedReader.take(id)) open.current();
  }, [wanted, requestedReader, id]);
}

/** Keeps a row mounted while something reads from it; see MessageRow. */
export const RowKeepAlive = createContext<(() => () => void) | undefined>(
  undefined,
);

/** Empty places a reader fills from its row. */
function useSlotElements(entry: Placed) {
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [description, setDescription] = useState<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const key = slotKey(entry.composer, entryId(entry.target));
  useLayoutEffect(() => {
    if (!body) return;
    setSlot(key, { title, leading, description, body });
    return () => setSlot(key, undefined);
  }, [key, title, leading, description, body]);
  return {
    title: <span ref={setTitle} className={styles.readerSlot} />,
    leading: <span ref={setLeading} className={styles.readerSlot} />,
    description: <span ref={setDescription} className={styles.readerSlot} />,
    body: <div ref={setBody} className={styles.readerSlot} />,
  };
}

/** Readers opened where nothing inline can hold them. */
function ReaderDialogs({ opener }: { opener: InlineOpener }) {
  const { store } = opener;
  const list = useSyncExternalStore(store.subscribe, store.get, store.get);
  return list
    .filter((item) => item.placement === "dialog")
    .map((item) => (
      <RowGate key={item.key} entry={item}>
        <ReaderDialog opener={opener} entry={item} />
      </RowGate>
    ));
}
/** A details or diff reader shows only while its row is there to draw it. */
function RowGate({ entry, children }: { entry: Placed; children: ReactNode }) {
  const present = useRowPresent(entry);
  const drawnByRow =
    entry.target.kind === "details" || entry.target.kind === "diff";
  return !drawnByRow || present ? children : null;
}
function ReaderDialog({
  opener,
  entry,
}: {
  opener: InlineOpener;
  entry: Placed;
}) {
  const { store } = opener;
  const slot = useSlotElements(entry);
  const id = entryId(entry.target);
  return (
    <Dialog
      open={entry.open}
      onOpenChange={(open) => {
        if (!open) opener.dismiss(id);
      }}
      onOpenChangeComplete={(open: boolean) => {
        if (!open) store.set((items) => removed(items, entry.key));
      }}
      title={slot.title}
      description={entry.target.kind === "details" && slot.description}
      size={entry.target.kind === "diff" ? "expanded" : "default"}
      closeLabel={behavior(entry).closeLabel}
      finalFocus={entry.focus}
    >
      {slot.body}
    </Dialog>
  );
}

type ThreadRenderer = (
  target: Extract<InlineTarget, { kind: "thread" }>,
  /** Filled by the thread with what its tab takes over on Open as tab. */
  handoff: { current: (() => ThreadHandoff) | undefined },
) => ReactNode;

/** A scope's composer handle, one per name for the scope's lifetime. */
export function useComposerHandle(name: ComposerName | undefined) {
  return useMemo(() => (name ? createComposerHandle(name) : undefined), [name]);
}

/** Provides `handle`'s composer to the content below, and draws what opens
 * over it beside it, inside the conversation that owns it. Leaving closes
 * what is over it, as when its tab closes. Threads open only over a
 * channel's composer, whose owner supplies `renderThread`. */
export function ComposerScopeProvider({
  handle,
  renderThread,
  children,
}: {
  handle: ComposerHandle | undefined;
  renderThread?: ThreadRenderer | undefined;
  children: ReactNode;
}) {
  const opener = useContext(InlineContainers);
  useEffect(
    () => () => {
      if (handle) opener?.composerGone(handle);
    },
    [opener, handle],
  );
  return (
    <ComposerScope value={handle}>
      {children}
      {opener && handle && (
        <Outlet opener={opener} handle={handle} renderThread={renderThread} />
      )}
    </ComposerScope>
  );
}

function Outlet({
  opener,
  handle,
  renderThread,
}: {
  opener: InlineOpener;
  handle: ComposerHandle;
  renderThread?: ThreadRenderer | undefined;
}) {
  const { store } = opener;
  const list = useSyncExternalStore(store.subscribe, store.get, store.get);
  const form = useComposerForm(handle);
  const host = form ? composerHost(handle) : null;
  useEffect(() => opener.outlet(handle), [opener, handle]);
  const mine = list.filter(
    (item) =>
      item.placement === "inline" && item.composer === handle && !item.waiting,
  );
  // The first inline thread on a device explains itself until it is done.
  const [intro, setIntro] = useState<number>();
  const [introStep, setIntroStep] = useState<InlineThreadIntroStep>(1);
  const [introAnchor, setIntroAnchor] = useState<HTMLElement | null>(null);
  const introducing = mine.some((item) => item.open && item.key === intro);
  const thread = host
    ? mine.find((item) => item.target.kind === "thread" && item.open)?.key
    : undefined;
  useEffect(() => {
    if (thread === undefined || introducing || inlineThreadIntroSeen()) return;
    setIntro(thread);
    setIntroStep(1);
  }, [thread, introducing]);
  const finishIntro = useCallback(() => {
    markInlineThreadIntroSeen();
    setIntro(undefined);
  }, []);
  // It waits, unshown, while its composer is away.
  if (!host) return null;
  return (
    <>
      {introducing && (
        <InlineThreadIntro
          step={introStep}
          anchor={introAnchor}
          onNext={() => setIntroStep(2)}
          onDone={() => setIntro(undefined)}
        />
      )}
      {mine.map((item) => (
        <RowGate key={item.key} entry={item}>
          <OutletEntry
            opener={opener}
            entry={item}
            tall={tall(list, item)}
            host={host}
            renderThread={renderThread}
            spotlight={item.key === intro ? introStep : undefined}
            onSpotlightAnchor={setIntroAnchor}
            finishIntro={finishIntro}
          />
        </RowGate>
      ))}
    </>
  );
}

/** A thread under a reader that owns its scrollport, a panel or a diff,
 * takes the full height while it is open: the reader sizes to the thread's
 * sheet, which a short thread keeps small. */
function tall(list: readonly Placed[], entry: Placed) {
  const name = provides(entry);
  return (
    !!name &&
    list.some(
      (item) =>
        item.open &&
        item.placement === "inline" &&
        item.composer?.name === name &&
        !!behavior(item).readerOnly,
    )
  );
}

function OutletEntry({
  opener,
  entry,
  tall,
  host,
  renderThread,
  spotlight,
  onSpotlightAnchor,
  finishIntro,
}: {
  opener: InlineOpener;
  entry: Placed;
  tall: boolean;
  host: NonNullable<ReturnType<typeof composerHost>>;
  renderThread?: ThreadRenderer | undefined;
  spotlight: InlineThreadIntroStep | undefined;
  onSpotlightAnchor(element: HTMLElement | null): void;
  finishIntro(): void;
}) {
  const { store } = opener;
  const { target } = entry;
  const id = entryId(target);
  const rules = behavior(entry);
  const slot = useSlotElements(entry);
  const handoff = useRef<() => ThreadHandoff>(undefined);
  // Close, Escape and the scrim dismiss it: history retires its visits.
  const close = () => opener.dismiss(id);
  const content =
    target.kind === "thread"
      ? renderThread?.(target, handoff)
      : target.kind === "panel"
        ? opener.renderPanel(target, {
            close,
            navigate: (next) => opener.navigate(id, next),
          })
        : slot.body;
  return (
    <DetailsSheet
      open={entry.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onClosed={() => store.set((items) => removed(items, entry.key))}
      host={host}
      title={
        target.kind === "thread"
          ? "Thread"
          : target.kind === "panel"
            ? target.title
            : slot.title
      }
      leading={target.kind === "details" ? slot.leading : undefined}
      description={target.kind === "details" ? slot.description : undefined}
      closeLabel={rules.closeLabel}
      containsComposer={!!rules.containsComposer}
      readerOnly={!!rules.readerOnly}
      tall={tall}
      focusContent={target.kind === "thread" && !!target.reply}
      finalFocus={entry.focus}
      spotlight={spotlight}
      onSpotlightAnchor={onSpotlightAnchor}
      // The first Escape finishes the intro; the next closes.
      onEscapeKey={() => {
        if (spotlight === undefined) return false;
        finishIntro();
        return true;
      }}
      onOpenAsTab={
        entry.openAsTab &&
        (() => {
          if (spotlight !== undefined) finishIntro();
          // Read before it leaves: the tab opens where the thread was read,
          // answering the reply it was answering.
          const carried =
            target.kind === "thread" ? handoff.current?.() : undefined;
          // Its tab places focus.
          entry.focus.current = null;
          opener.moveToTab(id);
          entry.openAsTab?.(carried);
        })
      }
    >
      {content}
    </DetailsSheet>
  );
}
