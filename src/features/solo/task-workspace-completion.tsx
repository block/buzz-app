import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../conversation/contracts";
import type { HostCompletionResult } from "../conversation/completion";
import type { SoloRegionBinding } from "../channel-navigation/solo-navigation-contract";
import { soloNavigationFor } from "../channel-navigation/solo-navigation";

const noSubscription = () => () => {};

/** `#` in a task draft files it in one of its region's workspaces, as
 * `solo-workspace:<id>`. Selection sets the draft's workspace; no chip. */
export function TaskWorkspaceCompletion({
  session,
  binding,
  query,
  publish,
}: Pick<ComposerCompletionProps, "session" | "query" | "publish"> & {
  binding: SoloRegionBinding;
}) {
  const catalog = soloNavigationFor(session)?.workspaces;
  const subscribe = useCallback(
    (listener: () => void) => {
      try {
        return catalog?.subscribe(binding, listener) ?? noSubscription();
      } catch {
        // An ended binding has nothing to observe; its snapshot says so.
        return noSubscription();
      }
    },
    [catalog, binding],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    catalog?.snapshot(binding),
  );
  useLayoutEffect(() => {
    const needle = query.query.trim().toLowerCase();
    const result: HostCompletionResult = {
      items: (snapshot?.workspaces ?? [])
        .filter((workspace) => workspace.name.toLowerCase().includes(needle))
        .map((workspace) => ({
          id: `solo-workspace:${workspace.id}`,
          label: workspace.name,
          detail: "Workspace",
          edit: {
            workspace: {
              id: `solo-workspace:${workspace.id}`,
              label: workspace.name,
            },
          },
        })),
      ...(snapshot?.status === "loading"
        ? { status: "Loading workspaces…" }
        : snapshot?.status !== "ready"
          ? { status: snapshot?.error ?? "Workspaces are unavailable." }
          : {}),
    };
    // The host accepts a workspace edit only from a bundled provider.
    const withdraw = publish(result as unknown as CompletionResult);
    return () => {
      if (withdraw) withdraw();
    };
  }, [snapshot, query.query, publish]);
  return null;
}
