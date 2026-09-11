import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AppServices } from "./services";
import { communityDestination } from "../features/communities/destination";
import type { OpenTarget } from "../features/navigation/targets";
import type { OpenFailure } from "../features/navigation/controller";

const channelsKey = "buzz.channels/channels";
export function useAppNavigation(services: AppServices) {
  const navigation = services.navigation;
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const pages = useSyncExternalStore(
    services.pages.subscribe,
    services.pages.snapshot,
  );
  const startup = useSyncExternalStore(
    services.plugins.subscribe,
    services.plugins.startup,
  );
  const target = state.entry.target;
  const scope = "scope" in target ? target.scope : undefined;
  const pageKey =
    target.kind === "page"
      ? `${target.pluginId}/${target.pageId}`
      : target.kind === "conversation"
        ? channelsKey
        : undefined;
  const page = pages.find((page) => page.key === pageKey);
  const membership = scope
    ? client.memberships.find(
        (item) => communityDestination(item.id).url === scope.communityOrigin,
      )
    : undefined;
  let failure: OpenFailure | undefined;
  let waiting = false;
  if (scope === null) {
    waiting = client.status === "loading" || client.selected !== null;
  } else if (scope) {
    if (client.status === "loading") waiting = true;
    else if (client.viewer !== scope.viewer) failure = "denied";
    else if (!membership) failure = "denied";
    else if (client.selected !== membership.id) waiting = true;
  }
  if (pageKey && !failure) {
    if (startup === "loading") waiting = true;
    else if (!page) failure = "unavailable";
    else if (target.kind === "page" && target.route) {
      try {
        if (
          !page.route ||
          page.route.version !== target.route.version ||
          !page.route.validate(target.route.params)
        )
          failure = "unavailable";
      } catch {
        failure = "unavailable";
      }
    }
  }
  if (
    target.kind === "settings" &&
    target.section &&
    !["profile", "plugins", "appearance"].includes(target.section)
  )
    failure = "unavailable";
  const request = useMemo(
    () => services.navigationHost.request(state.attempt),
    [services.navigationHost, state.attempt],
  );
  useEffect(() => {
    if (state.attempt.signal.aborted) return;
    if (failure) {
      services.navigationHost.complete(state.attempt, {
        status: "failed",
        reason: failure,
      });
      return;
    }
    if (
      scope === null &&
      client.status !== "loading" &&
      client.selected !== null
    )
      services.communities.select(null);
    if (
      scope &&
      client.status !== "loading" &&
      client.viewer === scope.viewer &&
      membership &&
      client.selected !== membership.id
    ) {
      services.communities.select(membership.id);
    }
  }, [services, state.attempt, failure, scope, client, membership]);
  useEffect(() => {
    if (!waiting && !failure && target.kind === "home")
      request.complete({ status: "opened" });
  }, [waiting, failure, target, request]);
  const select = (key: string) => {
    const selectedClient = services.communities.snapshot();
    let destination: OpenTarget;
    if (key === "home") destination = { version: 1, kind: "home" };
    else if (key === "settings") destination = { version: 1, kind: "settings" };
    else {
      const selected = pages.find((page) => page.key === key);
      if (!selected) return;
      destination = {
        version: 1,
        kind: "page",
        pluginId: selected.pluginId,
        pageId: selected.id,
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    }
    void navigation.open(destination);
  };
  return {
    state,
    target,
    pages,
    page,
    request,
    select,
    waiting,
    failure,
    selected: pageKey ?? target.kind,
    retry() {
      // Retrying presentation must also repair its failed dependency. Only touch the
      // selected, authorized destination; never reconnect an unrelated community.
      if (pageKey === channelsKey && !failure && !waiting) {
        const status = services.relay.snapshot().status;
        if (status === "error" || status === "disconnected")
          services.relay.retry();
      }
      void navigation.retry();
    },
  };
}
