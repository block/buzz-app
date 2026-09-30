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
import { ChannelsPage } from "./ChannelsPage";
import * as mentionsPlugin from "../mentions/index";
import * as sessionsPlugin from "../sessions/index";
import { PagesService } from "../../features/pages/service";
import { provideNavigation } from "../../features/navigation/service";
import { writeView } from "../../shared/view-state";
import userEvent from "@testing-library/user-event";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  vi.unstubAllGlobals();
});
async function mount(
  options: Parameters<typeof sessionsData>[0] = {},
  module = sessionsPlugin,
) {
  const data = sessionsData(options);
  writeView("sessions-fixture", "selected-channel", "general");
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) =>
    plugin.manifest.id === "buzz.mentions" ? mentionsPlugin : module,
  );
  const pages = new PagesService(ctx);
  provideNavigation(ctx, undefined);
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
  const view = render(
    <ChannelsPage
      relay={data.relay}
      panels={panels}
      pages={pages}
      providers={providers}
      extensions={extensions}
    />,
    { reactStrictMode: true },
  );
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
  return { data, runtime, plugin, view, pages, extensions, loadedHeads };
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
// TODO(channel-sessions-rebase): rewire these host-shell journeys through
// features/channel-navigation/ChannelSidebar. The rebased ChannelsPage no longer
// owns the channel sidebar; lower directory/session contracts remain covered.
it.skip("session replacement and channel switch dispose real detail readers", async () => {
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

it.skip.each([
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
        .querySelector("header strong"),
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

it.skip("real session revocation removes the directory destination and regrant requires fresh selection", async () => {
  const h = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByRole("region", { name: "Sessions" });
  const rootId = h.data.rows[0]?.rootId;
  if (!rootId) throw new Error("Missing fixture root");
  act(() => h.data.revoke());
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

it.skip("fixture thread traversal settles without pagination errors, including a reply refresh", async () => {
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
  fireEvent.input(within(thread).getByRole("textbox"), {
    target: { textContent: "A fixture regression reply" },
  });
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
    screen.getByText(/Threads that mention or include an agent/),
  ).toBeInTheDocument();
});
it.skip("same-channel selection and a private draft retire directory detail without revival", async () => {
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
  await user.click(
    screen.getByRole("button", { name: "More options for General" }),
  );
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

it.skip("channel preview follow-ups use exact explicit mentions, never private-session invitations or remembered recipients", async () => {
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
  const picker = await content.findByRole("region", {
    name: "Mention a channel member",
  });
  expect(picker).toHaveTextContent("Only members of this channel are shown.");
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
  fireEvent.input(content.getByRole("textbox"), {
    target: { textContent: "A plain follow-up" },
  });
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

it.skip("passive personal children coexist with private rows, switch from another channel and restore sidebar focus", async () => {
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
  const search = sidebar.getByRole("textbox", { name: "Search channels" });
  fireEvent.change(search, { target: { value: "General" } });
  expect(expand).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(expand);
  expect(expand).toHaveAttribute("aria-expanded", "true");
  fireEvent.change(search, { target: { value: "" } });
  expect(expand).toHaveAttribute("aria-expanded", "false");
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
