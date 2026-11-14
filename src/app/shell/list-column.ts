import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { isSidebarSectionRoute } from "../../features/channel-navigation/sidebar-section-route";
import { soloDraft } from "../../features/channel-navigation/routes";

/** Activity is Team's list: its address shows that list and no page of its own. */
const activityAddress = (target: OpenTarget) =>
  target.kind === "page" &&
  target.pluginId === "buzz.inbox" &&
  target.pageId === "inbox";

/** Pages whose content is a conversation, a draft of one, or a section's home. */
export function listsConversations(target: OpenTarget) {
  return (
    target.kind === "conversation" ||
    (target.kind === "page" &&
      target.pluginId === "buzz.channels" &&
      target.pageId === "channels") ||
    activityAddress(target)
  );
}

/**
 * The section a page route names: "Open Team" and "Open Solo" are addresses,
 * and the conversations page without a route is Team's.
 */
export function routedSection(target: OpenTarget) {
  if (target.kind !== "page" || !listsConversations(target)) return;
  if (!target.route || activityAddress(target)) return "messages";
  const params = target.route.params;
  return isSidebarSectionRoute(params) ? params.section : undefined;
}

/** A draft's own section, so its list opens on the collection it adds to. */
function draftSection(target: OpenTarget) {
  if (target.kind !== "page" || !listsConversations(target)) return;
  const params = target.route?.params;
  return params === "new-message" || params === "compose"
    ? "messages"
    : soloDraft(params)
      ? "solo"
      : undefined;
}

export type ListColumn = {
  /** Whether the list is shown beside the page. */
  open: boolean;
  /** The section it lists. Unset: the one the open conversation belongs to. */
  section: string | undefined;
  /** A person toggled it: the change may animate. */
  animate: boolean;
};
type Saved = Pick<ListColumn, "open" | "section">;

const closed: ListColumn = { open: false, section: undefined, animate: false };

/**
 * The one owner of the list column's state. A section address opens that
 * section's list. An open from the list keeps the list and one from the
 * sidebar closes it, whichever visit navigation lands on. Back and Forward
 * restore what a visit last showed, and any other visit leaves the list as it
 * is.
 */
export function useListColumn(navigator: Navigation | undefined) {
  const visit = useSyncExternalStore(
    navigator?.subscribe ?? noSubscription,
    () => navigator?.snapshot(),
  );
  const entryId = visit?.entry.id;
  const attemptId = visit?.attempt.id;
  const saved = useRef(new Map<string, Saved>());
  const [state, setState] = useState<{
    entryId: string | undefined;
    list: ListColumn;
  }>({ entryId: undefined, list: closed });
  // What an open in flight asked of the visit it lands on. Navigation may
  // return to a visit it already holds, which would otherwise look like Back.
  // Rendering only reads it and `saved`; commits update them.
  const asked = useRef<
    | { from: string | undefined; attempt: string | undefined; list: Saved }
    | undefined
  >(undefined);
  let list = state.list;
  if (state.entryId !== entryId) {
    const target = visit?.entry.target;
    const section = target && routedSection(target);
    const prior = entryId ? saved.current.get(entryId) : undefined;
    const request = asked.current;
    const intent =
      request && request.from === state.entryId ? request.list : undefined;
    list = section
      ? { open: true, section, animate: false }
      : intent
        ? { ...intent, animate: false }
        : visit?.attempt.traversal && prior
          ? { ...prior, animate: false }
          : {
              open: state.list.open,
              section: (target && draftSection(target)) ?? state.list.section,
              animate: false,
            };
    setState({ entryId, list });
  }
  // A request holds only on the visit and attempt that made it. The visit it
  // landed on spent it; an open that stayed on its visit started a new
  // attempt there and asked nothing of any later visit.
  useLayoutEffect(() => {
    const request = asked.current;
    if (request && (request.from !== entryId || request.attempt !== attemptId))
      asked.current = undefined;
  }, [entryId, attemptId]);
  const setOpen = useCallback(
    (open: boolean, animate = false) =>
      setState((current) => ({
        ...current,
        list: { ...current.list, open, animate },
      })),
    [],
  );
  const latest = useRef({ entryId, list });
  useLayoutEffect(() => {
    latest.current = { entryId, list };
    if (entryId) remember(saved.current, entryId, list);
  });
  /**
   * Call before opening: the visit that open lands on shows the list as it is
   * (opens from the list), closed (the sidebar opens destinations directly),
   * or open on a named section (a section opened on one of its conversations).
   */
  const ask = useCallback(
    (next: "keep" | "close" | { section: string }) => {
      asked.current = {
        from: latest.current.entryId,
        attempt: navigator?.snapshot().attempt.id,
        list:
          next === "keep"
            ? latest.current.list
            : next === "close"
              ? closed
              : { open: true, section: next.section },
      };
      // Closing applies at once, even when the destination is already open.
      if (next === "close")
        setState((current) => ({ ...current, list: closed }));
    },
    [navigator],
  );
  return { list, setOpen, ask };
}

function remember(saved: Map<string, Saved>, entryId: string, list: Saved) {
  saved.delete(entryId);
  saved.set(entryId, { open: list.open, section: list.section });
  if (saved.size > 100) {
    const first = saved.keys().next().value;
    if (first) saved.delete(first);
  }
}

const noSubscription = () => () => {};
