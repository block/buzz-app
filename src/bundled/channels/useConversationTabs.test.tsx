// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type {
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);
it("retained offline tabs can close, add and open threads without activating connected plugins", () => {
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  const panel = { key: "activity", title: "Activity" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "connecting", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => false,
      openLink: () => false,
    });
    return { state, workspace };
  });
  const entry = { panel, channelId: "alpha", target: "activity" };
  act(() => h.result.current.workspace.open(entry));
  expect(h.result.current.workspace.items).toHaveLength(1);
  expect(
    h.result.current.workspace.openConversationLink("alpha", "activity"),
  ).toBe(false);
  act(() => h.result.current.workspace.closeTab(entry));
  expect(h.result.current.state.entries).toEqual([]);
  act(() => h.result.current.workspace.addTab());
  expect(h.result.current.state.tabs).toHaveLength(1);
  act(() =>
    h.result.current.workspace.openConversationThread("beta", "root", "root"),
  );
  expect(h.result.current.state.tabs).toHaveLength(2);
  const staleAdd = h.result.current.workspace.addTab;
  h.unmount();
  act(() => staleAdd());
  const restored = renderHook(() => useChannelTabState(session, "alpha"));
  expect(restored.result.current.tabs).toHaveLength(2);
});

it("gives a panel the thread its link was opened from, retargeting a reopened tab", () => {
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  const panel = { key: "profile", title: "Profile" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() =>
    useConversationTabs({
      state: useChannelTabState(session, "alpha"),
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    }),
  );
  const context = () => {
    const [item] = h.result.current.items;
    if (!item) throw new Error("no panel tab");
    return (item.content as { props: { context: PanelContext } }).props.context;
  };
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "first",
    });
  });
  expect(context()).toMatchObject({ channelId: "alpha", rootId: "first" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "second",
    });
  });
  expect(h.result.current.items).toHaveLength(1);
  expect(context()).toMatchObject({ rootId: "second" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile");
  });
  expect(context()).not.toHaveProperty("rootId");
});
