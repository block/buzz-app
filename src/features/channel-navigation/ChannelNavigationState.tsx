import {
  createContext,
  useCallback,
  useLayoutEffect,
  useContext,
  useMemo,
  useState,
  useRef,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import { readView, writeView } from "../../shared/view-state";

/** The persistent sidebar owns writes/recovery; each menu owns its focus and read status. */
export type ChannelMenuSurface = {
  /** Navigation presentation lifetime, not the session-owned write lifetime. */
  signal?: AbortSignal | undefined;
  close(finalFocus?: () => HTMLElement | false): void;
  focus(): void;
  pending: boolean;
  runRead(action: () => Promise<unknown>): Promise<void>;
};
type MenuActions = (
  channel: ChannelSummary,
  surface: ChannelMenuSurface,
) => readonly ReactNode[];
function createMenuActions() {
  let current: MenuActions | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(actions: MenuActions | undefined) {
      current = actions;
      for (const listener of listeners) listener();
    },
  };
}
const noActions = () => undefined;
const noSubscribe = () => () => {};
export function useChannelMenuActions() {
  const handoff = useChannelNavigation();
  return useSyncExternalStore(
    handoff?.menuActions.subscribe ?? noSubscribe,
    handoff?.menuActions.snapshot ?? noActions,
  );
}

type PreparingDm = { existing: Set<string>; members: Set<string | undefined> };
type State = {
  session: RelaySession;
  scope: string;
  draftParents: string[];
  preparingDm: PreparingDm | undefined;
  lifecycleDialog:
    | {
        channel: ChannelSummary;
        action: ChannelLifecycleAction;
        trigger?: HTMLElement;
        focusFallback?: HTMLElement | undefined;
        origin?: AbortSignal;
      }
    | undefined;
};
type ActivityThread = {
  channelId: string;
  messageId: string;
  entryId: string;
  signal: AbortSignal;
  trigger: HTMLElement | null;
};
type ActivityAgent = {
  channelId: string;
  agent: string;
  trigger: HTMLElement | null;
};
type Handoff = State & {
  menuActions: ReturnType<typeof createMenuActions>;
  activityThread: RefObject<ActivityThread | undefined>;
  activityAgent: RefObject<ActivityAgent | undefined>;
  updateDraftParents(update: (previous: string[]) => string[]): void;
  prepareDm(members: readonly string[]): void;
  clearPreparingDm(): void;
  openLifecycle(
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
    trigger?: HTMLElement,
    origin?: AbortSignal,
  ): void;
  closeLifecycle(): void;
};
const ChannelNavigationContext = createContext<Handoff | undefined>(undefined);
export const useChannelNavigation = () => useContext(ChannelNavigationContext);

// UI intent shared by the persistent sidebar and the visible conversation page.
// Session replacement resets this state, not the independent page subtree.
export function ChannelNavigationProvider({
  relay,
  children,
}: {
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const scope = connection.scope ?? "disconnected";
  // biome-ignore lint/correctness/useExhaustiveDependencies: retire all sidebar callbacks when the relay session or scope changes.
  const menuActions = useMemo(createMenuActions, [connection.session, scope]);
  const activityThread = useRef<ActivityThread | undefined>(undefined);
  const activityAgent = useRef<ActivityAgent | undefined>(undefined);
  const [state, setState] = useState<State>(() =>
    restore(connection.session, scope),
  );
  if (state.session !== connection.session || state.scope !== scope) {
    activityThread.current = undefined;
    activityAgent.current = undefined;
    setState(restore(connection.session, scope));
  }
  const update = useCallback(
    (change: (previous: State) => State) => {
      // Retired page/dialog completions cannot mutate a replacement session.
      if (relay.snapshot().session !== connection.session) return;
      setState((previous) =>
        previous.session === connection.session ? change(previous) : previous,
      );
    },
    [relay, connection.session],
  );
  const clearPreparingDm = useCallback(() => {
    update((previous) =>
      previous.preparingDm ? { ...previous, preparingDm: undefined } : previous,
    );
  }, [update]);
  const lifecycleOrigin = state.lifecycleDialog?.origin;
  useLayoutEffect(() => {
    if (!lifecycleOrigin) return;
    const retire = () =>
      update((previous) =>
        previous.lifecycleDialog?.origin === lifecycleOrigin
          ? { ...previous, lifecycleDialog: undefined }
          : previous,
      );
    if (lifecycleOrigin.aborted) retire();
    else lifecycleOrigin.addEventListener("abort", retire, { once: true });
    return () => lifecycleOrigin.removeEventListener("abort", retire);
  }, [lifecycleOrigin, update]);
  const value = useMemo<Handoff>(
    () => ({
      ...state,
      menuActions,
      activityThread,
      activityAgent,
      updateDraftParents(change) {
        update((previous) => {
          const draftParents = change(previous.draftParents);
          writeView(previous.scope, "sessions:channel-drafts", draftParents);
          return { ...previous, draftParents };
        });
      },
      prepareDm(members) {
        // Capture before the caller starts opening the DM, not in a deferred updater.
        const existing = new Set(
          connection.session.channels
            .list()
            .channels.map((channel) => channel.id),
        );
        update((previous) => ({
          ...previous,
          preparingDm: {
            existing: previous.preparingDm?.existing ?? existing,
            members: new Set([connection.viewer, ...members]),
          },
        }));
      },
      openLifecycle(channel, action, trigger, origin) {
        update((previous) =>
          origin?.aborted || previous.lifecycleDialog
            ? previous
            : {
                ...previous,
                lifecycleDialog: {
                  channel,
                  action,
                  ...(trigger ? { trigger } : {}),
                  // Settings actions can remount after an archive-state change;
                  // the tab header lives outside the settings aside.
                  focusFallback:
                    trigger
                      ?.closest("[data-panel-workspace]")
                      ?.querySelector<HTMLElement>(
                        'button[aria-label="Close Channel settings tab"]',
                      ) ??
                    trigger
                      ?.closest("aside")
                      ?.querySelector<HTMLElement>("button") ??
                    undefined,
                  ...(origin ? { origin } : {}),
                },
              },
        );
      },
      closeLifecycle() {
        update((previous) => ({ ...previous, lifecycleDialog: undefined }));
      },
      clearPreparingDm,
    }),
    [
      state,
      menuActions,
      connection.session,
      connection.viewer,
      update,
      clearPreparingDm,
    ],
  );
  return (
    <ChannelNavigationContext value={value}>
      {children}
    </ChannelNavigationContext>
  );
}
function restore(session: RelaySession, scope: string): State {
  const saved = readView<unknown>(scope, "sessions:channel-drafts", []);
  return {
    session,
    scope,
    preparingDm: undefined,
    lifecycleDialog: undefined,
    draftParents: Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [],
  };
}
