import { expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RelayData } from "../../features/relay/service";
import { openFromNavigation } from "./open-from-navigation";

it("returning to a channel from a page that opened opens it again", () => {
  const scope = { communityOrigin: "wss://relay.example", viewer: "viewer" };
  const alpha: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
  };
  const page: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "inbox",
    pageId: "inbox",
  };
  let target: OpenTarget = alpha;
  let status = "opened";
  const listeners = new Set<() => void>();
  const navigation = {
    snapshot: () => ({ attempt: { entry: { target } }, status }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Navigation;
  const open = vi.fn();
  const session = { channels: { open } };
  const relay = {
    snapshot: () => ({
      session,
      scope: `${scope.communityOrigin}:${scope.viewer}`,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const navigate = (next: OpenTarget, result = "opened") => {
    target = next;
    status = result;
    for (const listener of listeners) listener();
  };
  const stop = openFromNavigation(navigation, relay);
  navigate(alpha);
  expect(open.mock.calls).toEqual([["alpha"]]);
  // A page that only passes through on its way back is still the visit.
  navigate(page, "opening");
  navigate(alpha);
  expect(open.mock.calls).toEqual([["alpha"]]);
  navigate(page);
  navigate(alpha);
  expect(open.mock.calls).toEqual([["alpha"], ["alpha"]]);
  stop();
});
