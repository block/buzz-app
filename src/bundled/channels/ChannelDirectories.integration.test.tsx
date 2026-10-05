// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../../features/conversation/service";
import { PanelsService } from "../../features/panels/service";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ChannelSidebar } from "../../features/channel-navigation/ChannelSidebar";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import { ChannelsPage } from "./ChannelsPage";
import * as mentionsPlugin from "../mentions/index";
import * as sessionsPlugin from "../sessions/index";
import { PagesService } from "../../features/pages/service";
import { provideNavigation } from "../../features/navigation/service";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { writeView } from "../../shared/view-state";
import userEvent from "@testing-library/user-event";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
composerDOMFixture();
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // jsdom has no layout; real visibility/focus eligibility is covered in browsers.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 100, 20),
  ] as unknown as DOMRectList);
});
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount(
  options: Parameters<typeof sessionsData>[0] = {},
  module = sessionsPlugin,
) {
  const data = sessionsData({ ...options, canonicalScope: true });
  writeView(data.scope, "selected-channel", "general");
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) =>
    plugin.manifest.id === "buzz.mentions" ? mentionsPlugin : module,
  );
  const pages = new PagesService(ctx);
  const navigationHost = provideNavigation(ctx, undefined);
  ctx.provide("relay", data.relay);
  const extensions = new ConversationService(ctx);
  const panels = new PanelsService(ctx);
  const emptyProviders = [] as const;
  const providers = {
    snapshot: () => emptyProviders,
    subscribe: () => () => {},
    register: () => {},
  };
  const plugin = {
    manifest: {
      id: "buzz.sessions",
      name: "Sessions",
      apiVersion: 1 as const,
    },
    enabled: true,
    source: "bundled" as const,
    revision: "one",
    previous: null,
    error: null,
    reloadable: false,
  };
  cleanups.push(async () => {
    data.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
  });
  function Harness() {
    const [away, setAway] = useState(false);
    const [holdPresentation, setHoldPresentation] = useState(false);
    const state = useSyncExternalStore(
      navigationHost.navigation.subscribe,
      navigationHost.navigation.snapshot,
    );
    const registered = useSyncExternalStore(pages.subscribe, pages.snapshot);
    const [presentation, setPresentation] = useState<{
      attempt: typeof state.attempt;
      request: ReturnType<typeof navigationHost.request>["request"];
    }>();
    useLayoutEffect(() => {
      if (holdPresentation) return;
      const { request, dispose } = navigationHost.request(state.attempt, {
        valid: () => true,
        subscribe: () => () => {},
      });
      setPresentation({ attempt: state.attempt, request });
      return dispose;
    }, [state.attempt, holdPresentation]);
    return (
      <ChannelNavigationProvider relay={data.relay}>
        <button
          type="button"
          onClick={() => setHoldPresentation((held) => !held)}
        >
          {holdPresentation
            ? "Bind fixture presentation"
            : "Hold fixture presentation"}
        </button>
        <button type="button" onClick={() => setAway(true)}>
          Other fixture page
        </button>
        <ChannelSidebar
          relay={data.relay}
          navigator={navigationHost.navigation}
          providers={providers}
          target={state.entry.target}
          channelDirectories={extensions.channelDirectories}
          sessionsEnabled={registered.some(
            (page) => page.pluginId === "buzz.sessions",
          )}
        >
          {null}
        </ChannelSidebar>
        {away ? (
          <button type="button" onClick={() => setAway(false)}>
            Return fixture page
          </button>
        ) : (
          <ChannelsPage
            relay={data.relay}
            panels={panels}
            pages={pages}
            providers={providers}
            extensions={extensions}
            navigator={navigationHost.navigation}
            navigation={
              !holdPresentation && presentation?.attempt === state.attempt
                ? presentation.request
                : undefined
            }
          />
        )}
      </ChannelNavigationProvider>
    );
  }
  const view = render(<Harness />, { reactStrictMode: true });
  await screen.findByRole("textbox", {
    name:
      options.channelType === "dm"
        ? "Message #Fixture member"
        : options.channelType === "session"
          ? "Message this session"
          : "Message #General",
  });
  await waitFor(() =>
    expect(data.session.channels.window("general").status).toBe("ready"),
  );
  const loadedHeads = data.report.queries
    .flat()
    .filter((filter) => filter.top_level).length;
  // No contribution or tab before the actual Sessions plugin activates.
  expect(
    screen.queryByRole("tab", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    runtime.reconcile([plugin]);
  });
  await waitFor(() =>
    expect(extensions.channelDirectories.snapshot()).toHaveLength(
      module === sessionsPlugin ? 1 : 2,
    ),
  );
  expect(pages.snapshot()).toHaveLength(1);
  expect(pages.snapshot()[0]?.key).toBe("buzz.sessions/sessions");
  expect(
    data.report.queries.flat().filter((filter) => filter.top_level),
  ).toHaveLength(loadedHeads);
  expect(
    data.report.queries
      .flat()
      .some((filter) => filter["#e"] && !filter.depth_limit),
  ).toBe(false);
  return {
    data,
    runtime,
    plugin,
    view,
    pages,
    extensions,
    loadedHeads,
    navigation: navigationHost.navigation,
  };
}
it("real host directory mounts no hidden timeline/composer/readers, then owns exactly one ordinary thread", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByRole("region", { name: "Sessions" });
  expect(
    screen.queryByRole("textbox", { name: "Message #General" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-message-id]")).toBeNull();
  expect(document.querySelector("[data-channel-timeline]")).toBeNull();
  const readingLeases = h.data.report.readingLeases;
  fireEvent.focusIn(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  fireEvent.keyDown(screen.getByRole("region", { name: "Sessions" }), {
    key: "ArrowDown",
  });
  expect(h.data.report.readingLeases).toBe(readingLeases);
  expect(h.data.report.activeReaders).toBe(0);
  expect(
    h.data.report.queries.flat().filter((filter) => filter.top_level),
  ).toHaveLength(h.loadedHeads);
  expect(
    h.data.report.queries.flat().some((filter) => filter.depth_limit),
  ).toBe(false);
  expect(h.data.report.published).toEqual([]);
  const row = within(
    screen.getByRole("region", { name: "Sessions" }),
  ).getByRole("button", {
    name: /Review the release checklist/,
  });
  row.focus();
  fireEvent.click(row);
  await screen.findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  expect(h.data.report.activeReaders).toBe(1);
  expect(
    screen.queryByRole("region", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).getByRole(
        "button",
        { name: /Review the release checklist/ },
      ),
    ).toHaveFocus(),
  );
  expect(h.data.report.activeReaders).toBe(0);
});
it("real thread read failure exposes existing retry, and removal retires detail without resurrection", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  h.data.failThread(true);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  const retry = await screen.findByRole("button", { name: /Retry/ });
  h.data.failThread(false);
  fireEvent.click(retry);
  await screen.findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  await act(async () => {
    h.runtime.reconcile([]);
  });
  await screen.findByText(/Sessions unavailable/);
  expect(h.pages.snapshot()).toHaveLength(0);
  expect(h.data.report.activeReaders).toBe(0);
  expect(
    within(screen.getByRole("article", { name: "Conversation" })).queryByRole(
      "textbox",
    ),
  ).not.toBeInTheDocument();
  await act(async () => {
    h.runtime.reconcile([h.plugin]);
  });
  await waitFor(() => expect(h.pages.snapshot()).toHaveLength(1));
  expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Return to Channel" }));
  await screen.findByRole("textbox", { name: "Message #General" });
});
it("session replacement and channel switch dispose real detail readers", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  await screen.findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  await screen.findByRole("textbox", { name: "Message #Other" });
  expect(h.data.report.activeReaders).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: /^General/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  await screen.findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  act(() => h.data.replace());
  await screen.findByRole("textbox", { name: "Message #General" });
  expect(h.data.report.activeReaders).toBe(0);
});

it("revocation during a held real thread read disposes it and fences the late result", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  const gate = h.data.holdThread();
  try {
    fireEvent.click(
      within(screen.getByRole("region", { name: "Sessions" })).getByRole(
        "button",
        { name: /Review the release checklist/ },
      ),
    );
    await act(async () => {
      await gate.started;
    });
    expect(h.data.report.activeReaders).toBe(1);
    act(() => h.data.revoke());
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Sessions" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("complementary", { name: "Session" }),
    ).not.toBeInTheDocument();
    // Exact routed destinations do not silently substitute another channel.
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByRole("textbox", { name: "Message #Other" });
    expect(h.data.report.activeReaders).toBe(0);
  } finally {
    await act(async () => {
      gate.release();
    });
  }
  expect(
    screen.queryByRole("complementary", { name: "Session" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    ),
  ).not.toBeInTheDocument();
});

it.each([
  ["channel metadata", "directory"],
  ["channel metadata", "detail"],
  ["member profile", "directory"],
  ["member profile", "detail"],
])(
  "%s label updates preserve the selected %s, focus and reader lifetime",
  async (source, surface) => {
    const h = await mount();
    fireEvent.click(
      within(
        screen.getByRole("complementary", { name: "Channel sidebar" }),
      ).getByRole("button", {
        name: /^General/,
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    const row = await within(
      screen.getByRole("region", { name: "Sessions" }),
    ).findByRole("button", {
      name: /Review the release checklist/,
    });
    row.focus();
    if (surface === "detail") {
      fireEvent.click(row);
      await screen.findByText(
        "Fixture reply for task 1. The conversation stays in its original thread.",
      );
    }
    const focused = document.activeElement;
    const directory = screen.queryByRole("region", {
      name: "Sessions",
    });
    const thread = screen.queryByRole("complementary", { name: "Session" });
    const { readers, activeReaders, readingLeases } = h.data.report;
    act(() => {
      if (source === "member profile") h.data.renameMember("Updated member");
      else h.data.renameChannel("Updated channel");
    });
    const label = source === "member profile" ? "General" : "Updated channel";
    expect(
      screen
        .getByRole("article", { name: "Conversation" })
        .querySelector("header"),
    ).toHaveTextContent(label);
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.activeElement).toBe(focused);
    expect(h.data.report).toMatchObject({
      readers,
      activeReaders,
      readingLeases,
    });
    if (surface === "directory") {
      expect(screen.getByRole("region", { name: "Sessions" })).toBe(directory);
      fireEvent.click(row);
      await screen.findByText(
        "Fixture reply for task 1. The conversation stays in its original thread.",
      );
    } else {
      expect(screen.getByRole("complementary", { name: "Session" })).toBe(
        thread,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Sessions" })).getByRole(
          "button",
          { name: /Review the release checklist/ },
        ),
      ).toHaveFocus(),
    );
  },
);

it("real session revocation removes the directory destination and regrant requires fresh selection", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByRole("region", { name: "Sessions" });
  const rootId = h.data.rows[0]?.rootId;
  if (!rootId) throw new Error("Missing fixture root");
  act(() => h.data.revoke());
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Sessions" }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  await screen.findByRole("textbox", { name: "Message #Other" });
  expect(
    h.data.session.channels
      .list()
      .channels.some((channel) => channel.id === "general"),
  ).toBe(false);
  expect(
    screen.queryByRole("region", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  act(() => h.data.regrant());
  fireEvent.click(screen.getByRole("button", { name: /^General/ }));
  await screen.findByRole("textbox", { name: "Message #General" });
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  await screen.findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
});

it("fixture thread traversal settles without pagination errors, including a reply refresh", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Sessions" })).getByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  const thread = await screen.findByRole("complementary", { name: "Session" });
  const settled = async () => {
    // Visible replies precede the automatic continuation. Observe the real
    // reader's terminal state before negative UI assertions; errors also settle.
    await waitFor(() => {
      const snapshot = h.data.threadSnapshot();
      expect(
        snapshot?.status === "error" ||
          (snapshot?.status === "ready" && !snapshot.canLoadMore),
      ).toBe(true);
    });
    expect(h.data.threadSnapshot()).toMatchObject({
      status: "ready",
      error: undefined,
      canLoadMore: false,
      limited: false,
    });
    expect(within(thread).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(thread).queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
    expect(
      within(thread).queryByText("Loading thread…"),
    ).not.toBeInTheDocument();
  };
  await settled();
  expect(h.data.threadSnapshot()?.replies).toHaveLength(1);
  const pages = () =>
    h.data.report.queries.flat().filter((filter) => filter.depth_limit);
  // StrictMode can start and retire an initial read. The active traversal must
  // still issue its empty continuation, rather than treating a short page as EOF.
  expect(pages().at(-1)).toMatchObject({
    thread_cursor: h.data.now,
    thread_cursor_id: h.data.threadSnapshot()?.replies[0]?.id,
  });
  const completedPages = pages().length;
  const reply = within(thread).getByRole("textbox") as ComposerInputElement;
  act(() => {
    reply.value = "A fixture regression reply";
  });
  fireEvent.input(reply);
  fireEvent.click(within(thread).getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(
      h.data.report.published.filter((event) => event.kind === 9),
    ).toHaveLength(1),
  );
  const published = h.data.report.published.find((event) => event.kind === 9);
  expect(published?.tags).toContainEqual([
    "e",
    h.data.rows[0]?.rootId,
    "",
    "reply",
  ]);
  expect(published?.tags.some(([key]) => key === "p")).toBe(false);
  expect(
    h.data.report.published.some(
      (event) => event.kind === 9000 || event.kind === 9007,
    ),
  ).toBe(false);
  await act(async () => {
    await h.data.refreshThread();
  });
  await settled();
  expect(h.data.threadSnapshot()?.replies).toHaveLength(2);
  expect(pages().slice(completedPages)).toHaveLength(2);
  expect(
    within(thread).getByText("A fixture regression reply", { exact: true }),
  ).toBeVisible();
});

it.each(["dm", "session"] as const)(
  "never offers the channel directory in a %s channel",
  async (channelType) => {
    const h = await mount({ channelType });
    expect(
      screen.queryByRole("tab", { name: "Sessions" }),
    ).not.toBeInTheDocument();
    expect(h.extensions.channelDirectories.snapshot()).toHaveLength(1);
  },
);
it("offers agent-only loaded Sessions in a forum", async () => {
  await mount({ channelType: "forum" });
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByRole("region", { name: "Sessions" });
  expect(
    screen.getByText(
      /Checked history · replies sampled; some sessions may be missing/,
    ),
  ).toBeInTheDocument();
});
it("same-channel selection and a private draft retire directory detail without revival", async () => {
  const h = await mount();
  const open = async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    fireEvent.click(
      await within(screen.getByRole("region", { name: "Sessions" })).findByRole(
        "button",
        {
          name: /Review the release checklist/,
        },
      ),
    );
    await screen.findByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    );
    expect(h.data.report.activeReaders).toBe(1);
  };
  await open();
  fireEvent.click(screen.getByRole("button", { name: /^General/ }));
  await screen.findByRole("textbox", { name: "Message #General" });
  expect(h.data.report.activeReaders).toBe(0);
  await open();
  const user = userEvent.setup();
  const channelRow = within(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  ).getByRole("button", { name: /^General/ });
  channelRow.focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await user.click(
    await screen.findByRole("menuitem", { name: "New session" }),
  );
  await screen.findByRole("region", { name: "New session in General" });
  expect(
    screen.getByRole("button", {
      name: "Collapse sessions in General",
    }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("button", { name: "New session draft in General" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("tab", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  expect(h.data.report.activeReaders).toBe(0);
  expect(h.data.report.published).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: /^General/ }));
  await screen.findByRole("textbox", { name: "Message #General" });
  expect(screen.getByRole("tab", { name: "Channel" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("channel preview follow-ups use exact explicit mentions, never private-session invitations or remembered recipients", async () => {
  const h = await mount();
  await act(async () =>
    h.runtime.reconcile([
      h.plugin,
      {
        ...h.plugin,
        reloadable: false,
        manifest: {
          ...h.plugin.manifest,
          id: "buzz.mentions",
          name: "Mentions",
        },
      },
    ]),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  fireEvent.click(
    await within(screen.getByRole("region", { name: "Sessions" })).findByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  );
  const thread = await screen.findByRole("complementary", { name: "Session" });
  const content = within(thread);
  fireEvent.click(
    await content.findByRole("button", { name: "Mention a member" }),
  );
  const picker = await screen.findByRole("dialog", {
    name: "Mention a member or agent",
  });
  expect(picker).toHaveTextContent("Fixture member");
  fireEvent.click(
    await within(picker).findByRole("button", {
      name: `Fixture member ${h.data.member}`,
    }),
  );
  fireEvent.click(content.getByRole("button", { name: "Send message" }));
  const messages = () =>
    h.data.report.published.filter((event) => event.kind === 9);
  await waitFor(() => expect(messages()).toHaveLength(1));
  expect(messages()[0]?.tags).toContainEqual(["p", h.data.member]);
  expect(messages()[0]?.tags).toContainEqual([
    "e",
    h.data.rows[0]?.rootId,
    "",
    "reply",
  ]);
  const followUp = content.getByRole("textbox") as ComposerInputElement;
  act(() => {
    followUp.value = "A plain follow-up";
  });
  fireEvent.input(followUp);
  fireEvent.click(content.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(messages()).toHaveLength(2));
  expect(messages()[1]?.tags.some(([key]) => key === "p")).toBe(false);
  expect(
    h.data.report.published.some(
      (event) => event.kind === 9000 || event.kind === 9007,
    ),
  ).toBe(false);
});

it("real signed root and later human mention classify Sessions; namesake human-only work stays out", async () => {
  const h = await mount();
  const gate = h.data.holdEvidence();
  try {
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    await act(async () => {
      await gate.started;
    });
    expect(screen.getByText("Checking threads for agents…")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).getByRole(
        "button",
        { name: /Review the release checklist/ },
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).getByRole(
        "button",
        { name: /Unanswered agent request/ },
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
        "button",
        { name: /Explore the onboarding flow/ },
      ),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => gate.release());
  }
  await within(screen.getByRole("region", { name: "Sessions" })).findByRole(
    "button",
    { name: /Explore the onboarding flow/ },
  );
  await waitFor(() =>
    expect(screen.queryByText("Checking threads for agents…")).toBeNull(),
  );
  expect(
    within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
      "button",
      { name: /Human-only planning thread/ },
    ),
  ).not.toBeInTheDocument();
  const batches = () =>
    h.data.report.queries
      .flat()
      .filter((filter) => filter["#e"] && !filter.depth_limit);
  // The retired StrictMode mount never dispatches; the surviving tab owns one batch.
  expect(batches()).toHaveLength(1);
  expect(batches()[0]).toMatchObject({
    kinds: [40002, 9], // Shared reader canonicalizes filter arrays.
    "#h": ["general"],
    limit: 200,
  });
  expect(batches()[0]?.["#e"]).toHaveLength(4);
  act(() => h.data.agentHint(false));
  expect(
    within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
      "button",
      { name: /Review the release checklist/ },
    ),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
      "button",
      { name: /Explore the onboarding flow/ },
    ),
  ).not.toBeInTheDocument();
  act(() => h.data.agentHint(true));
  await within(screen.getByRole("region", { name: "Sessions" })).findByRole(
    "button",
    { name: /Explore the onboarding flow/ },
  );
  expect(batches()).toHaveLength(1);
  expect(h.data.report.readers).toBe(0);
  expect(h.data.report.published).toEqual([]);
});

it("real cache reset cancels a held classification batch; late results cannot restore cleared roots", async () => {
  const h = await mount();
  const gate = h.data.holdEvidence();
  try {
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    await act(async () => {
      await gate.started;
    });
    await act(async () => {
      await h.data.owner.clearCache();
    });
    expect(h.data.session.profiles.snapshot().size).toBe(0);
    expect(h.data.session.agentLibrary.snapshot().identities).toEqual([]);
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
        "button",
        { name: /Review the release checklist/ },
      ),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => gate.release());
  }
  expect(
    within(screen.getByRole("region", { name: "Sessions" })).queryByRole(
      "button",
      { name: /Explore the onboarding flow/ },
    ),
  ).not.toBeInTheDocument();
  expect(h.data.session.profiles.snapshot().size).toBe(0);
  expect(h.data.report.readers).toBe(0);
});

it("revocation fences a held real classification read without leaking the former channel", async () => {
  const h = await mount();
  const gate = h.data.holdEvidence();
  try {
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    await act(async () => {
      await gate.started;
    });
    act(() => h.data.revoke());
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Sessions" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("complementary", { name: "Session" }),
    ).not.toBeInTheDocument();
    // Exact routed destinations do not silently substitute another channel.
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByRole("textbox", { name: "Message #Other" });
  } finally {
    await act(async () => gate.release());
  }
  expect(
    screen.queryByRole("region", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Explore the onboarding flow"),
  ).not.toBeInTheDocument();
  expect(h.data.report.readers).toBe(0);
});

it("header creation is a distinct local blank draft; backing out restores directory focus and ordinary channel text", async () => {
  const h = await mount();
  const input = screen.getByRole<
    import("../../features/messages/composer-dom").ComposerInputElement
  >("textbox", { name: "Message #General" });
  input.value = "keep the channel draft";
  fireEvent.input(input);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  const draft = screen.getByRole("textbox", {
    name: "Message this session",
  });
  expect(draft).toHaveProperty("value", "");
  expect(
    screen.queryByRole("textbox", { name: "Message #General" }),
  ).not.toBeInTheDocument();
  expect(h.data.report.published).toHaveLength(0);
  expect(h.data.report.readingLeases).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
  expect(screen.getByRole("tab", { name: "Sessions" })).toHaveFocus();
  fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
  expect(
    screen.getByRole("textbox", { name: "Message #General" }),
  ).toHaveTextContent("keep the channel draft");
});

it("passive personal children coexist with private rows, switch from another channel and restore sidebar focus", async () => {
  const h = await mount();
  const sidebar = within(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const expand = sidebar.getByRole("button", {
    name: "Expand sessions in General",
  });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(
    sidebar.queryByRole("region", { name: "Your sessions in General" }),
  ).not.toBeInTheDocument();
  // Search expansion remains covered by useSidebarView.test.tsx; the persistent
  // sidebar deliberately has no search field.
  fireEvent.click(expand);
  const personal = () =>
    within(sidebar.getByRole("region", { name: "Your sessions in General" }));
  const root = await personal().findByRole("button", {
    name: "Review the release checklist",
  });
  expect(
    personal().getByRole("button", { name: "View all sessions" }),
  ).toHaveAccessibleDescription("From loaded history · may be incomplete");

  const queries = h.data.report.queries.length;
  root.focus();
  expect(h.data.report.queries.length).toBe(queries);
  fireEvent.click(sidebar.getByRole("button", { name: "Other" }));
  await screen.findByRole("textbox", { name: "Message #Other" });
  root.focus();
  fireEvent.click(root);
  await screen.findByRole("complementary", { name: "Session" });
  expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(root).toHaveAttribute("aria-current", "page");
  const readers = h.data.report.readers;
  act(() => h.data.renameChannel("General renamed"));
  expect(h.data.report.readers).toBe(readers);
  fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
  await waitFor(() => expect(root).toHaveFocus());
  fireEvent.click(sidebar.getByRole("button", { name: "Other" }));
  fireEvent.click(
    within(
      sidebar.getByRole("region", { name: "Your sessions in General renamed" }),
    ).getByRole("button", { name: "View all sessions" }),
  );
  await screen.findByRole("region", { name: "Sessions" });
  expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(h.data.report.published).toEqual([]);
  await act(async () => {
    h.runtime.reconcile([]);
  });
  await waitFor(() =>
    expect(
      sidebar.queryByRole("region", {
        name: "Your sessions in General renamed",
      }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Return to Channel" }));
  expect(
    await screen.findByRole("textbox", { name: "Message #General renamed" }),
  ).toBeVisible();
});

it("an inline contribution failure stays inside the accessory and leaves the ordinary transcript/composer alive", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const module = {
    ...sessionsPlugin,
    apply: ((ctx) => {
      sessionsPlugin.apply(ctx);
      ctx.conversation.registerChannelDirectory({
        id: "broken-detail",
        title: "Broken detail",
        component: (props) => (
          <button
            type="button"
            onClick={() => {
              const root = props.session.channels
                .window(props.channelId)
                .rows.find((row) => row.threadRootId === undefined);
              if (root) props.openThread(root.id);
            }}
          >
            Open broken detail
          </button>
        ),
        threadAccessory: () => {
          throw new Error("Synthetic accessory failure");
        },
      });
    }) as typeof sessionsPlugin.apply,
  };
  try {
    const h = await mount({}, module);
    fireEvent.click(screen.getByRole("tab", { name: "Broken detail" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open broken detail" }),
    );
    await screen.findByText("Agent activity unavailable");
    await waitFor(() => expect(h.data.threadSnapshot()?.status).toBe("ready"));
    expect(
      screen
        .getByRole("region", { name: "Session messages" })
        .querySelector("[data-message-id]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Message this session" }),
    ).toBeVisible();
    expect(h.data.report.activeReaders).toBe(1);
    expect(screen.queryByText(/Broken detail unavailable/)).toBeNull();
    expect(h.data.report.published).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
    expect(
      await screen.findByRole("button", { name: "Open broken detail" }),
    ).toBeVisible();
    expect(h.data.report.activeReaders).toBe(0);
  } finally {
    error.mockRestore();
  }
});

it("real inline activity stays after the root, resets disclosure on retarget and retires with the plugin destination", async () => {
  const h = await mount({ agentActivity: true });
  const release = h.data.session.agentActivity.activate();
  try {
    const firstRoot = h.data.rows[0]?.rootId,
      secondRoot = h.data.rows[1]?.rootId;
    if (!firstRoot || !secondRoot) throw new Error("Missing fixture roots");
    act(() => {
      h.data.telemetry("turn_started", [firstRoot], "first");
      h.data.telemetry("turn_started", [secondRoot], "second");
    });
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    const open = async (name: RegExp) => {
      fireEvent.click(
        await within(
          screen.getByRole("region", { name: "Sessions" }),
        ).findByRole("button", { name }),
      );
      await waitFor(() =>
        expect(h.data.threadSnapshot()?.status).toBe("ready"),
      );
      return screen.getByRole("region", { name: "Session agent activity" });
    };
    const first = await open(/Review the release checklist/);
    fireEvent.click(
      within(first).getByRole("button", { name: "Agent activity" }),
    );
    fireEvent.click(
      await within(first).findByRole("button", { name: "Details" }),
    );
    await waitFor(() =>
      expect(first.querySelector("pre")?.textContent).toContain(
        '"turnId":"first"',
      ),
    );
    const history = screen.getByRole("region", { name: "Session messages" });
    const rows = history.querySelectorAll("[data-message-id]");
    expect(rows[0]?.compareDocumentPosition(first)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(first.compareDocumentPosition(rows[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
    const second = await open(/Explore the onboarding flow/);
    const toggle = within(second).getByRole("button", {
      name: "Agent activity",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(second.querySelector("pre")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(
      await within(second).findByRole("button", { name: "Details" }),
    );
    await waitFor(() =>
      expect(second.querySelector("pre")?.textContent).toContain(
        '"turnId":"second"',
      ),
    );
    expect(second.textContent).not.toContain('"turnId":"first"');
    expect(h.data.report.activeReaders).toBe(1);
    await act(async () => h.runtime.reconcile([]));
    await screen.findByText(/Sessions unavailable/);
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    expect(h.data.report.activeReaders).toBe(0);
    expect(h.data.report.published).toEqual([]);
  } finally {
    release();
  }
});

async function openShareDetail() {
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  const region = await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(
    within(region).getByRole("button", {
      name: /Review the release checklist/,
    }),
  );
  return screen.findByRole("button", { name: "Share in channel" });
}

it("Share retains the real channel editor document and undo history without publishing", async () => {
  const h = await mount({ canonicalScope: true });
  const input = screen.getByRole("textbox", {
    name: "Message #General",
  }) as ComposerInputElement;
  act(() => {
    input.insertText("Keep this ");
    input.toggleFormat("bold");
    input.insertText("formatted");
    input.setSelectionRange(0, 4);
  });
  const before = input.captureCheckpoint();
  const share = await openShareDetail();
  expect(
    screen.queryByRole("textbox", { name: "Message #General" }),
  ).not.toBeInTheDocument();
  fireEvent.click(share);
  const returned = (await screen.findByRole("textbox", {
    name: "Message #General",
  })) as ComposerInputElement;
  expect(returned.value).toContain("Keep this formatted");
  expect(returned.querySelector("strong")).toHaveTextContent("formatted");
  expect(returned).toHaveTextContent(
    `Session · ${h.data.rows[0]?.rootId.slice(0, 8)}Review the release checklist`,
  );
  expect(returned).toHaveFocus();
  expect(returned.selectionStart).toBe(returned.value.length);
  act(() => returned.undo(false));
  expect(returned.captureCheckpoint().state.doc.eq(before.state.doc)).toBe(
    true,
  );
  expect(returned.selectionStart).toBe(0);
  expect(returned.selectionEnd).toBe(4);
  act(() => returned.undo(true));
  expect(returned).toHaveTextContent(
    `Session · ${h.data.rows[0]?.rootId.slice(0, 8)}Review the release checklist`,
  );
  expect(h.data.report.published).toEqual([]);
});

it("Share latches a saved conflict and explicit recovery preserves local Undo", async () => {
  const h = await mount({ canonicalScope: true });
  const input = screen.getByRole("textbox", {
    name: "Message #General",
  }) as ComposerInputElement;
  act(() => input.insertText("Local draft"));
  await openShareDetail();
  fireEvent.click(screen.getByRole("button", { name: "Open in thread" }));
  const thread = await screen.findByRole("complementary", { name: "Thread" });
  await within(thread).findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  await waitFor(() => expect(h.navigation.snapshot().status).toBe("opened"));
  const routedEntry = h.navigation.snapshot().entry;
  const share = await openShareDetail();
  writeView(h.data.scope, "draft:general", "Other window draft");
  fireEvent.click(share);
  // Failed append must not navigate or revoke the still-mounted exact detail.
  expect(h.navigation.snapshot().entry).toBe(routedEntry);
  expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.queryByRole("complementary", { name: "Thread" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Share in channel" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
  const returned = (await screen.findByRole("textbox", {
    name: "Message #General",
  })) as ComposerInputElement;
  expect(returned.value).toBe("Local draft");
  const composer = returned.closest("form");
  if (!composer) throw new Error("Missing channel composer");
  expect(
    within(composer).getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("region", { name: "Channel draft conflict" }),
  ).toHaveTextContent("Other window draft");
  fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
  expect(returned.value).toBe("Other window draft");
  act(() => returned.undo(false));
  expect(returned.value).toBe("Local draft");
  act(() => returned.undo(true));
  expect(returned.value).toBe("Other window draft");
  expect(h.data.report.published).toEqual([]);
});

it.each(["prior typing", "Share"])(
  "Share retains rich local text, recipients and Undo when writes first fail on %s",
  async (firstFailure) => {
    const h = await mount({ canonicalScope: true });
    const input = screen.getByRole("textbox", {
      name: "Message #General",
    }) as ComposerInputElement;
    act(() => {
      input.insertText("Keep ");
      input.toggleFormat("bold");
      input.insertText("formatted");
      input.toggleFormat("bold");
      input.insertText(" @Viewer ", { pubkey: h.data.viewer, name: "Viewer" });
    });
    const key = `buzz-view.v1:${JSON.stringify([h.data.scope, "draft:general"])}`;
    const baseline = localStorage.getItem(key);
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      if (firstFailure === "prior typing")
        act(() => input.insertText("Unsaved local text"));
      act(() => input.setSelectionRange(0, 4));
      const before = input.captureCheckpoint();
      fireEvent.click(await openShareDetail());
      const returned = (await screen.findByRole("textbox", {
        name: "Message #General",
      })) as ComposerInputElement;
      expect(returned.value).toContain(before.draft.text);
      expect(returned).toHaveTextContent(
        `Session · ${h.data.rows[0]?.rootId.slice(0, 8)}Review the release checklist`,
      );
      expect(returned.querySelector("strong")).toHaveTextContent("formatted");
      expect(returned.captureCheckpoint().draft.recipients).toEqual(
        before.draft.recipients,
      );
      expect(before.draft.recipients).toEqual([
        { pubkey: h.data.viewer, name: "Viewer", start: 14, end: 21 },
      ]);
      expect(returned).toHaveFocus();
      expect(returned.selectionStart).toBe(returned.value.length);
      expect(
        screen.queryByRole("region", { name: "Channel draft conflict" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
      const shared = returned.captureCheckpoint();
      act(() => returned.undo(false));
      expect(returned.captureCheckpoint().state.doc.eq(before.state.doc)).toBe(
        true,
      );
      expect(returned.selectionStart).toBe(0);
      expect(returned.selectionEnd).toBe(4);
      act(() => returned.undo(true));
      expect(returned.captureCheckpoint().state.doc.eq(shared.state.doc)).toBe(
        true,
      );
      expect(returned.captureCheckpoint().draft.recipients).toEqual(
        before.draft.recipients,
      );
      expect(localStorage.getItem(key)).toBe(baseline);
      expect(fail).toHaveBeenCalled();
      expect(h.data.report.published).toEqual([]);
    } finally {
      fail.mockRestore();
    }
  },
);

it.each(["malformed", "read failure"])(
  "Share handles %s without changing the local document and recovers explicitly",
  async (failure) => {
    const h = await mount({ canonicalScope: true });
    const input = screen.getByRole("textbox", {
      name: "Message #General",
    }) as ComposerInputElement;
    act(() => input.insertText("Local recovery"));
    const key = `buzz-view.v1:${JSON.stringify([h.data.scope, "draft:general"])}`;
    const original = localStorage.getItem(key);
    const share = await openShareDetail();
    const spy =
      failure === "read failure"
        ? vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
          })
        : undefined;
    if (failure === "malformed") localStorage.setItem(key, "{");
    try {
      fireEvent.click(share);
    } finally {
      spy?.mockRestore();
    }
    expect(
      screen.getByRole("button", { name: "Share in channel" }),
    ).toBeInTheDocument();
    if (failure === "malformed") {
      fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
      expect(
        screen.getByRole("button", { name: "Retry saved draft" }),
      ).toBeInTheDocument();
      localStorage.setItem(key, original ?? "null");
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved draft" }),
      );
    } else {
      fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
      // Main's revision owner does not silently refresh an unreadable Share
      // review. Explicit retry observes it before Load chooses that exact value.
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved draft" }),
      );
    }
    const returned = (await screen.findByRole("textbox", {
      name: "Message #General",
    })) as ComposerInputElement;
    expect(returned.value).toBe("Local recovery");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
    fireEvent.click(await openShareDetail());
    const recovered = (await screen.findByRole("textbox", {
      name: "Message #General",
    })) as ComposerInputElement;
    expect(recovered.value).toContain("Local recovery [Session:");
    act(() => recovered.undo(false));
    expect(recovered.value).toBe("Local recovery");
    expect(h.data.report.published).toEqual([]);
  },
);

it("Share does not replace an unreadable draft already present when the editor mounts", async () => {
  const get = Storage.prototype.getItem;
  const spy = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, key: string) {
      return key.includes('"draft:general"') ? "{" : get.call(this, key);
    });
  try {
    const h = await mount({ canonicalScope: true });
    fireEvent.click(await openShareDetail());
    fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
    expect(
      screen.getByRole("button", { name: "Retry saved draft" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(h.data.report.published).toEqual([]);
    expect(
      get.call(
        localStorage,
        `buzz-view.v1:${JSON.stringify([h.data.scope, "draft:general"])}`,
      ),
    ).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

it("a pending sidebar intent suppresses hidden channel startup when Channels mounts independently in StrictMode", async () => {
  const h = await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Expand sessions in General" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Other fixture page" }));
  const sidebar = within(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const root = await sidebar.findByRole("button", {
    name: "Review the release checklist",
  });
  const heads = h.data.report.queries
    .flat()
    .filter((filter) => filter.top_level).length;
  const leases = h.data.report.readingLeases;
  fireEvent.click(root);
  fireEvent.click(screen.getByRole("button", { name: "Return fixture page" }));
  await screen.findByRole("complementary", { name: "Session" });
  expect(
    screen.queryByRole("textbox", { name: "Message #General" }),
  ).not.toBeInTheDocument();
  expect(
    h.data.report.queries.flat().filter((filter) => filter.top_level),
  ).toHaveLength(heads);
  expect(h.data.report.readingLeases).toBe(leases);
  expect(h.data.report.activeReaders).toBe(1);
});

it.each(["General", "Other"])(
  "holds undefined presentation without starting saved %s before the exact sidebar handoff binds",
  async (savedChannel) => {
    const h = await mount();
    const sidebar = within(
      screen.getByRole("complementary", { name: "Channel sidebar" }),
    );
    fireEvent.click(
      sidebar.getByRole("button", { name: "Expand sessions in General" }),
    );
    if (savedChannel === "Other") {
      fireEvent.click(sidebar.getByRole("button", { name: "Other" }));
      await screen.findByRole("textbox", { name: "Message #Other" });
      await waitFor(() =>
        expect(h.data.session.channels.window("other").status).toBe("ready"),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Other fixture page" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Hold fixture presentation" }),
    );
    const ensures = h.data.report.windowEnsures.length;
    const leases = h.data.report.readingLeases;
    try {
      fireEvent.click(
        sidebar.getByRole("button", { name: "Review the release checklist" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Return fixture page" }),
      );
      // act has committed the independent StrictMode mount and its effects while
      // presentation stays explicitly held, not synchronously bound by useMemo.
      expect(document.querySelector("[data-channel-timeline]")).toBeNull();
      expect(
        screen.queryByRole("textbox", { name: /^Message #/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("complementary", { name: "Session" }),
      ).not.toBeInTheDocument();
      expect(h.data.report.windowEnsures).toHaveLength(ensures);
      expect(h.data.report.readingLeases).toBe(leases);
      fireEvent.click(
        screen.getByRole("button", { name: "Bind fixture presentation" }),
      );
      await screen.findByRole("complementary", {
        name: "Session",
      });
      expect(h.data.report.windowEnsures).toHaveLength(ensures);
      expect(h.data.report.readingLeases).toBe(leases);
      expect(h.data.report.activeReaders).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
      await screen.findByRole("region", { name: "Sessions" });
      fireEvent.click(screen.getByRole("tab", { name: "Channel" }));
      await screen.findByRole("textbox", { name: "Message #General" });
      expect(
        document.querySelector('[data-channel-timeline="general"]'),
      ).not.toBeNull();
    } finally {
      const bind = screen.queryByRole("button", {
        name: "Bind fixture presentation",
      });
      if (bind) fireEvent.click(bind);
    }
  },
);

it("Open in thread reuses the same session root in the ordinary channel panel without publishing or changing the parent draft", async () => {
  const h = await mount();
  const input = screen.getByRole("textbox", {
    name: "Message #General",
  }) as ComposerInputElement;
  act(() => input.insertText("Keep my channel draft"));
  const before = input.captureCheckpoint();
  await openShareDetail();
  const rootId = h.data.rows[0]?.rootId;
  await waitFor(() => expect(h.data.threadSnapshot()?.status).toBe("ready"));
  expect(
    screen
      .getByRole("region", { name: "Session messages" })
      .querySelector("[data-message-id]"),
  ).toHaveAttribute("data-message-id", rootId);
  const open = screen.getByRole("button", { name: "Open in thread" });
  fireEvent.focus(open);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Open in thread",
  );
  expect(open.textContent).toBe("");
  fireEvent.click(open);
  const thread = await screen.findByRole("complementary", {
    name: "Thread",
  });
  await waitFor(() =>
    expect(thread.querySelector("[data-message-id]")).toHaveAttribute(
      "data-message-id",
      rootId,
    ),
  );
  expect(
    screen.queryByRole("complementary", { name: "Session" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Channel" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const returned = screen.getByRole("textbox", {
    name: "Message #General",
  }) as ComposerInputElement;
  expect(returned.captureCheckpoint().state.doc.eq(before.state.doc)).toBe(
    true,
  );
  expect(h.data.report.activeReaders).toBe(1);
  expect(h.data.report.published).toEqual([]);
});

it("Open in thread then directory Share retires the routed panel and preserves exact draft recipients and Back", async () => {
  const h = await mount();
  const input = screen.getByRole("textbox", {
    name: "Message #General",
  }) as ComposerInputElement;
  act(() => {
    input.insertText("Keep ");
    input.toggleFormat("bold");
    input.insertText("formatted");
    input.toggleFormat("bold");
    input.insertText(" @Viewer ", { pubkey: h.data.viewer, name: "Viewer" });
    input.setSelectionRange(0, 4);
  });
  const before = input.captureCheckpoint();
  const rootId = h.data.rows[0]?.rootId;
  for (let visit = 0; visit < 2; visit++) {
    await openShareDetail();
    fireEvent.click(screen.getByRole("button", { name: "Open in thread" }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    await within(thread).findByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    );
    await waitFor(() => expect(h.navigation.snapshot().status).toBe("opened"));
    expect(h.navigation.snapshot().entry.target).toMatchObject({
      channelId: "general",
      messageId: rootId,
      threadRootId: rootId,
    });
    expect(input.captureCheckpoint().state.doc.eq(before.state.doc)).toBe(true);
    expect(h.data.report.published).toEqual([]);
  }
  const routedEntry = h.navigation.snapshot().entry.id;
  fireEvent.click(await openShareDetail());
  const returned = (await screen.findByRole("textbox", {
    name: "Message #General",
  })) as ComposerInputElement;
  await waitFor(() =>
    expect(
      screen.queryByRole("complementary", { name: "Thread" }),
    ).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(h.navigation.snapshot().status).toBe("opened"));
  expect(h.navigation.snapshot().entry.target).not.toHaveProperty("messageId");
  expect(screen.getByRole("tab", { name: "Channel" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(returned).toHaveFocus();
  expect(returned.value).toContain(before.draft.text);
  expect(returned.querySelector("strong")).toHaveTextContent("formatted");
  expect(returned.captureCheckpoint().draft.recipients).toEqual(
    before.draft.recipients,
  );
  expect(before.draft.recipients).toEqual([
    { pubkey: h.data.viewer, name: "Viewer", start: 14, end: 21 },
  ]);
  expect(returned.querySelectorAll('[data-link-kind="session"]')).toHaveLength(
    1,
  );
  act(() => returned.undo(false));
  expect(returned.captureCheckpoint().state.doc.eq(before.state.doc)).toBe(
    true,
  );
  expect(returned.selectionStart).toBe(0);
  expect(returned.selectionEnd).toBe(4);
  act(() => returned.undo(true));
  const shared = returned.captureCheckpoint();
  act(() => h.navigation.back());
  const backThread = await screen.findByRole("complementary", {
    name: "Thread",
  });
  await within(backThread).findByText(
    "Fixture reply for task 1. The conversation stays in its original thread.",
  );
  await waitFor(() => expect(h.navigation.snapshot().status).toBe("opened"));
  expect(h.navigation.snapshot().entry.id).toBe(routedEntry);
  act(() => h.navigation.forward());
  await waitFor(() => expect(h.navigation.snapshot().status).toBe("opened"));
  expect(
    screen.queryByRole("complementary", { name: "Thread" }),
  ).not.toBeInTheDocument();
  expect(returned.captureCheckpoint().state.doc.eq(shared.state.doc)).toBe(
    true,
  );
  expect(h.data.report.published).toEqual([]);
});
