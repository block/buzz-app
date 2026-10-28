import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import {
  createChannelPresentation,
  type ChannelPresentation,
  type ChannelRowPresentation,
} from "./channel-presentation";
const noop = () => () => {};
const noNames: ReadonlyMap<string, string | undefined> = new Map();
const emptyNames = { subscribe: noop, snapshot: () => noNames };
export const ChannelPresentationContext = createContext<
  ChannelPresentation | undefined
>(undefined);
export const ChannelRowPresentationContext = createContext<
  ChannelRowPresentation | undefined
>(undefined);

/** Construction is private/pure. Only committed external-store subscriptions
 * acquire sources; the owner reconnects after StrictMode's subscription probe. */
export function useChannelPresentation(
  session: RelaySession,
  channelId: string,
  chat: boolean,
  viewer: string | undefined,
) {
  const owner = useMemo(
    () => createChannelPresentation(session, channelId, { chat, viewer }),
    [session, channelId, chat, viewer],
  );
  const header = useSyncExternalStore(
    owner.subscribeHeader,
    owner.header,
    owner.header,
  );
  useEffect(() => session.channels.ensure(channelId), [session, channelId]);
  return { owner, header };
}
export function useChannelRow(owner: ChannelPresentation, id: string) {
  const subscribe = useCallback(
    (listener: () => void) => owner.subscribeRow(id, listener),
    [owner, id],
  );
  const snapshot = useCallback(() => owner.row(id), [owner, id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
/** Explicit displayed keys select immutable labels. Unrelated profile/name
 * publications do not invalidate this consumer; no live resolver is captured. */
export function usePresentedNames(
  session: RelaySession | undefined,
  channelId: string,
  ids: readonly string[],
) {
  const candidate = useContext(ChannelPresentationContext);
  const owner =
    candidate &&
    candidate.session === session &&
    candidate.channelId === channelId
      ? candidate
      : undefined;
  const key = JSON.stringify([...new Set(ids)].sort());
  const selected = useMemo(
    () =>
      owner && key !== "[]"
        ? owner.names(JSON.parse(key) as string[])
        : emptyNames,
    [owner, key],
  );
  const names = useSyncExternalStore(
    selected.subscribe,
    selected.snapshot,
    selected.snapshot,
  );
  return useCallback(
    (id: string, fallback: string) => names.get(id) ?? fallback,
    [names],
  );
}
