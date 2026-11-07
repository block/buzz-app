// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { afterEach, expect, it } from "vitest";
import {
  PanelWorkspace,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import type {
  PanelProps,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);

it.each([
  ["main", true],
  ["side", true],
  ["main", false],
  ["side", false],
  ["main", undefined],
  ["side", undefined],
] as const)(
  "preserves %s panel lifetimes with deferred mounting=%s",
  (pane, deferUntilShown) => {
    const channels = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const mounted = new Set<string>();
    const disposed: string[] = [];
    let revision = 0;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const snapshot = () => revision;
    const panel = {
      key: "app",
      title: "App",
      keepOpen: true,
      ...(deferUntilShown !== undefined && { deferUntilShown }),
      component: function Content({ target }: PanelProps) {
        usePanelTabTitle(target);
        const current = useSyncExternalStore(subscribe, snapshot, snapshot);
        useEffect(() => {
          mounted.add(target);
          return () => {
            mounted.delete(target);
            disposed.push(target);
          };
        }, [target]);
        return (
          <input
            aria-label={`Draft ${target}`}
            aria-description={`Background revision ${current}`}
          />
        );
      },
    } as RegisteredPanel;
    const available = [panel];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
    } as unknown as Panels;
    const session = {
      viewer: "viewer",
      channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
    } as unknown as RelayData;
    let state!: ReturnType<typeof useChannelTabState>;
    let workspace!: ReturnType<typeof useConversationTabs>;
    function Harness({ channelId }: { channelId: string }) {
      const previous = useRef<string>(undefined);
      const continuingVisit = previous.current === channelId;
      useLayoutEffect(() => {
        previous.current = channelId;
      }, [channelId]);
      state = useChannelTabState(session, channelId);
      workspace = useConversationTabs({
        profiles: new Map(),
        state,
        relay,
        session,
        panels,
        current: channels.find((channel) => channel.id === channelId),
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit,
        mainPane: true,
        isLive: () => true,
        openLink: () => false,
      });
      return (
        <PanelWorkspace
          key={channelId}
          main={pane === "main"}
          value={
            pane === "main" ? workspace.selectedMain : workspace.selectedTab
          }
          select={(id) =>
            pane === "main"
              ? state.selectMain(id)
              : workspace.selectPanelTab(id)
          }
          items={pane === "main" ? workspace.mainItems : workspace.items}
        />
      );
    }
    const view = render(
      <StrictMode>
        <Harness channelId="alpha" />
      </StrictMode>,
    );
    const entries = Array.from({ length: 50 }, (_, index) => ({
      panel,
      channelId: "alpha",
      target: `target-${index}`,
    }));
    act(() => {
      state.setEntries(entries);
      if (pane === "main")
        for (const entry of entries)
          state.moveEntry(`app:${entry.target}`, "main");
      else {
        state.select("app:target-49");
        state.setPaneOpen(false);
      }
    });
    expect(screen.getAllByRole("tab")).toHaveLength(50);
    if (pane === "side") {
      expect(mounted.size).toBe(deferUntilShown ? 0 : 50);
      act(() => state.setPaneOpen(true));
    }
    const allTargets = entries.map((entry) => entry.target);
    expect([...mounted]).toEqual(deferUntilShown ? ["target-49"] : allTargets);
    if (!deferUntilShown)
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
        allTargets,
      );
    const draft = screen.getByRole("textbox", { name: "Draft target-49" });
    fireEvent.change(draft, { target: { value: "Unfinished reply" } });
    act(() =>
      pane === "main"
        ? state.selectMain("app:target-0")
        : workspace.selectPanelTab("app:target-0"),
    );
    expect([...mounted].sort()).toEqual(
      deferUntilShown ? ["target-0", "target-49"] : [...allTargets].sort(),
    );
    expect(draft).toBeInTheDocument();
    act(() => {
      revision++;
      for (const listener of listeners) listener();
    });
    expect(draft).toHaveAttribute("aria-description", "Background revision 1");
    act(() =>
      pane === "main"
        ? state.selectMain("app:target-49")
        : workspace.selectPanelTab("app:target-49"),
    );
    expect(screen.getByRole("textbox", { name: "Draft target-49" })).toBe(
      draft,
    );
    expect(draft).toHaveValue("Unfinished reply");
    view.rerender(
      <StrictMode>
        <Harness channelId="beta" />
      </StrictMode>,
    );
    expect(mounted.size).toBe(0);
    view.rerender(
      <StrictMode>
        <Harness channelId="alpha" />
      </StrictMode>,
    );
    expect([...mounted]).toEqual(deferUntilShown ? ["target-49"] : allTargets);
    expect(screen.getAllByRole("tab")).toHaveLength(50);
    expect(
      screen
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("data-tab-value")),
    ).toEqual(entries.map((entry) => `app:${entry.target}`));
    act(() => workspace.closeOtherTabs("app:target-49"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    act(() => workspace.closeAllTabs());
    expect(mounted.size).toBe(0);
    expect(disposed).toContain("target-0");
    act(() => {
      workspace.open({ panel, channelId: "alpha", target: "target-0" }, true);
      if (pane === "main") state.moveEntry("app:target-0", "main");
    });
    expect(screen.getByRole("textbox", { name: "Draft target-0" })).toHaveValue(
      "",
    );
    view.unmount();
    expect(mounted.size).toBe(0);
    expect(listeners.size).toBe(0);
  },
);

it("keeps a channel's menu tab while away and drops it if the channel became ineligible", () => {
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  const panel = {
    key: "canvas",
    title: "Canvas",
    channelMenu: { label: "View canvas", eligible: () => true },
    component: () => <p>Canvas contents</p>,
  } as unknown as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
  } as unknown as Panels;
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  // Stands in for ChannelsPage's membership/archive eligibility check.
  const eligibleChannels = new Set(["alpha", "beta"]);
  let state!: ReturnType<typeof useChannelTabState>;
  let workspace!: ReturnType<typeof useConversationTabs>;
  function Harness({ channelId }: { channelId: string }) {
    state = useChannelTabState(session, channelId);
    workspace = useConversationTabs({
      profiles: new Map(),
      state,
      relay,
      session,
      panels,
      current: channels.find((channel) => channel.id === channelId),
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: false,
      mainPane: true,
      isLive: () => true,
      openLink: () => false,
      eligible: (entry) =>
        entry.channelId === channelId && eligibleChannels.has(channelId),
    });
    return (
      <PanelWorkspace
        key={channelId}
        value={workspace.selectedTab}
        select={(id) => workspace.selectPanelTab(id)}
        items={workspace.items}
      />
    );
  }
  const view = render(<Harness channelId="alpha" />);
  act(() =>
    workspace.open({ panel, channelId: "alpha", target: "alpha" }, true),
  );
  expect(screen.getByText("Canvas contents")).toBeInTheDocument();
  view.rerender(<Harness channelId="beta" />);
  expect(screen.queryByText("Canvas contents")).not.toBeInTheDocument();
  view.rerender(<Harness channelId="alpha" />);
  expect(screen.getByText("Canvas contents")).toBeInTheDocument();
  view.rerender(<Harness channelId="beta" />);
  eligibleChannels.delete("alpha");
  view.rerender(<Harness channelId="alpha" />);
  expect(screen.queryByText("Canvas contents")).not.toBeInTheDocument();
  expect(state.entries).toEqual([]);
  // Regaining eligibility does not reopen what was dropped.
  eligibleChannels.add("alpha");
  view.rerender(<Harness channelId="beta" />);
  view.rerender(<Harness channelId="alpha" />);
  expect(screen.queryByText("Canvas contents")).not.toBeInTheDocument();
});

const agent = "a".repeat(64);
it.each([
  [
    "the newest control for the same profile",
    agent,
    ["Earlier", "Agent"],
    "button",
    "Agent",
  ],
  ["the messages, without one", agent, [], "region", "Channel message history"],
  [
    "the opener while it remains",
    agent,
    ["Working agent"],
    "button",
    "Working agent",
  ],
  [
    "the channel menu from another opener",
    undefined,
    ["Agent"],
    "button",
    "Channel actions",
  ],
] as const)(
  "closing a profile returns focus to %s",
  (_, opener, replacement, role, name) => {
    const channels = [{ id: "alpha", name: "Alpha" }];
    const panel = {
      key: "profile",
      title: "Profile",
      component: () => <p>Profile</p>,
    } as unknown as RegisteredPanel;
    const available = [panel];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
    } as unknown as Panels;
    const session = {
      viewer: "viewer",
      channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
    } as unknown as RelayData;
    let workspace!: ReturnType<typeof useConversationTabs>;
    // A byline link, as AuthorLink renders it.
    const identity = (label: string, pubkey: string | undefined) => (
      // biome-ignore lint/a11y/useSemanticElements: matches AuthorLink
      <span
        key={label}
        role="button"
        tabIndex={-1}
        data-profile-pubkey={pubkey}
      >
        {label}
      </span>
    );
    function Harness({ rows }: { rows: readonly string[] }) {
      const history = useRef<HTMLElement>(null);
      const fallback = useRef<HTMLButtonElement>(null);
      const state = useChannelTabState(session, "alpha");
      workspace = useConversationTabs({
        profiles: new Map(),
        state,
        relay,
        session,
        panels,
        current: channels[0],
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: false,
        isLive: () => true,
        openLink: () => false,
        fallbackFocus: fallback,
        history,
      });
      return (
        <>
          <button type="button" ref={fallback}>
            Channel actions
          </button>
          <section ref={history} tabIndex={-1}>
            <section
              data-message-scroller=""
              tabIndex={-1}
              aria-label="Channel message history"
            >
              {rows.map((label) =>
                identity(label, label === "Working agent" ? opener : agent),
              )}
              {identity("Someone else", "b".repeat(64))}
              {/* A hidden copy is not a destination. */}
              <div inert>{identity("Inert agent", agent)}</div>
            </section>
          </section>
          <PanelWorkspace
            value={workspace.selectedTab}
            select={(id) => workspace.selectPanelTab(id)}
            items={workspace.items}
          />
        </>
      );
    }
    const view = render(<Harness rows={["Working agent"]} />);
    const trigger = screen.getByRole("button", { name: "Working agent" });
    act(() => {
      trigger.focus();
      workspace.panelTrigger.current = trigger;
      workspace.open({ panel, channelId: "alpha", target: "profile" }, true);
    });
    expect(screen.getByText("Profile", { selector: "p" })).toBeVisible();
    // The live row can be replaced while the profile is open.
    view.rerender(<Harness rows={replacement} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Profile tab" }));
    expect(screen.queryByText("Profile", { selector: "p" })).toBeNull();
    expect(screen.getByRole(role, { name })).toHaveFocus();
  },
);
