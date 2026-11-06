// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import type { Panels } from "../../features/panels/service";
import { StrictMode } from "react";
import { createRelaySession } from "../../features/relay/session";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { matchesEvent } from "../../features/relay/projection";
import {
  bounds,
  profile,
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { writeView } from "../../shared/view-state";
import { SOLO_LABEL } from "../../features/solo/labels";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { ChannelsPage } from "./ChannelsPage";
import { ConversationTab } from "./ConversationTab";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  // Only the browser layout boundary is supplied; rows, editor, session,
  // reply routing and signing are real. Pixel/scroll assertions live in Playwright.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 800,
                  height: target.hasAttribute("data-message-scroller")
                    ? 600
                    : 80,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function (options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture({
  type = "stream",
  tab = false,
  foreignAgentTarget = false,
}: {
  type?: "stream" | "solo";
  tab?: boolean;
  foreignAgentTarget?: boolean;
} = {}) {
  const viewer = keypair(),
    authority = keypair();
  const channelId = "alpha";
  const agent = keypair();
  const root = signed(foreignAgentTarget ? authority : viewer, {
    kind: 9,
    tags: [
      ["h", channelId],
      ...(foreignAgentTarget ? [["p", agent.pubkey]] : []),
    ],
    content: "Reply target",
  });
  const events = [
    roster(authority, channelId, [viewer.pubkey, authority.pubkey]),
    metadata(
      authority,
      channelId,
      "Alpha",
      undefined,
      type === "solo"
        ? [["t", "stream"], ["private"], ["t", SOLO_LABEL]]
        : [["t", "stream"]],
    ),
    profile(authority, { name: "Teammate" }),
    ...(foreignAgentTarget
      ? [profile(agent, { name: "Honey", is_agent: true })]
      : []),
    root,
  ];
  let live!: LiveCallbacks;
  let omitTimelineTarget = false;
  let targetReadGate: Promise<void> | undefined;
  let targetReadStarted = () => {};
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) => {
        if (filters.some((filter) => filter.ids?.includes(root.id))) {
          targetReadStarted();
          await targetReadGate;
        }
        return [
          ...events.filter((event) =>
            filters.some(
              (filter) =>
                !(
                  omitTimelineTarget &&
                  filter.top_level &&
                  event.id === root.id
                ) && matchesEvent(event, filter),
            ),
          ),
          ...filters.flatMap((filter) =>
            filter.top_level
              ? (filter["#h"] ?? []).map((id) =>
                  bounds(authority, id, "head", {
                    has_more: false,
                    next_cursor: null,
                  }),
                )
              : [],
          ),
        ];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, dispose() {}, retry() {} };
      },
      writer: { sign: async (template) => signed(viewer, template), publish },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const session = owner.session;
  const scope = `https://relay.test:${viewer.pubkey}`;
  writeView(scope, "selected-channel", channelId);
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  live.state({ status: "connected", routes: [] });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const channel = session.channels.list().channels[0];
  assert(channel);
  const empty: readonly never[] = [];
  const panels: Panels = {
    snapshot: () => empty,
    subscribe: () => () => {},
    resolve: () => undefined,
    register() {},
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  const navigator = createNavigationController(
    createMemoryHistory(),
  ).navigation;
  const view = (focusRequest = 1) => (
    <StrictMode>
      <ToastProvider>
        <button type="button">Outside control</button>
        {tab ? (
          <ConversationTab
            tab={{
              id: "conversation:alpha",
              kind: "conversation",
              channelId,
              focusRequest,
            }}
            active
            channel={channel}
            session={session}
            scope={scope}
            openLink={() => false}
            canOpenLink={() => false}
            openThread={() => {}}
            close={() => {}}
          />
        ) : (
          <ChannelsPage relay={relay} navigator={navigator} panels={panels} />
        )}
      </ToastProvider>
    </StrictMode>
  );
  const mounted = render(view());
  const user = userEvent.setup();
  const message = await screen.findByText("Reply target");
  const input = screen.getByRole("textbox") as ComposerInputElement;
  const hold = async () => {
    await user.pointer({ target: message, keys: "[MouseLeft>]" });
    await screen.findByRole("button", { name: "Cancel reply target" });
    await waitFor(() => expect(screen.getByText(/Replying to/)).toBeVisible());
    await user.pointer({ keys: "[/MouseLeft]" });
  };
  return {
    user,
    message,
    pauseTargetRead() {
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        targetReadStarted = resolve;
      });
      targetReadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { started, release };
    },
    input,
    hold,
    publish,
    root,
    session,
    mounted,
    view,
    async evictTimelineTarget() {
      omitTimelineTarget = true;
      act(() => session.channels.refresh?.(channelId));
      await waitFor(() =>
        expect(session.channels.window(channelId).rows).toHaveLength(0),
      );
    },
    receive(event: RelayEvent) {
      events.push(event);
      act(() => live.receive([event]));
    },
    overlay(kind: number, content = "") {
      return signed(viewer, {
        kind,
        content,
        created_at: root.created_at + 1,
        tags: [
          ["e", root.id],
          ["h", channelId],
        ],
      });
    },
  };
}

it.each(["stream", "solo"] as const)(
  "holding a %s message retains its draft, cancels, and sends a signed reply",
  async (type) => {
    const h = await fixture({ type });
    act(() => h.input.insertText("A targeted reply"));
    await h.hold();
    expect(screen.getByRole("textbox")).toBe(h.input);
    await h.user.keyboard("{Escape}");
    expect(
      screen.queryByRole("button", { name: "Cancel reply target" }),
    ).not.toBeInTheDocument();
    expect(h.input).toHaveTextContent("A targeted reply");
    await h.hold();
    await h.user.click(h.input);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await h.user.keyboard("{Enter}");
    await waitFor(() => expect(h.publish).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        h.publish.mock.calls.some(
          ([event]) =>
            event.content === "A targeted reply" &&
            event.tags.some(
              (tag) =>
                tag[0] === "e" && tag[1] === h.root.id && tag[3] === "reply",
            ),
        ),
      ).toBe(true),
    );
    expect(
      screen.queryByRole("button", { name: "Cancel reply target" }),
    ).not.toBeInTheDocument();
  },
);

it("does not replay a local reply focus when a secondary tab's external request expires", async () => {
  const h = await fixture({ tab: true });
  await h.hold();
  h.mounted.rerender(h.view(2));
  await waitFor(() => expect(h.input).toHaveFocus());
  const control = screen.getByRole("button", { name: "Outside control" });
  // Capture the browser's default pointer focus before React flushes the request
  // expiry. A refocus effect must not override that user-owned focus.
  act(() => {
    fireEvent.pointerDown(control);
    control.focus();
  });
  expect(control).toHaveFocus();
});

it("updates the selected target after edits and blocks a deleted target without losing the draft", async () => {
  const h = await fixture();
  act(() => h.input.insertText("Keep this draft"));
  await h.hold();
  h.receive(h.overlay(40003, "Edited reply target"));
  const cancel = screen.getByRole("button", { name: "Cancel reply target" });
  const preview = cancel.parentElement;
  assert(preview);
  await waitFor(() =>
    expect(within(preview).getByText("Edited reply target")).toBeVisible(),
  );
  await h.evictTimelineTarget();
  expect(within(preview).getByText("Edited reply target")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  h.receive(h.overlay(5));
  await screen.findByText("Reply target is no longer available.");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(screen.getByRole("textbox")).toBe(h.input);
  expect(h.input).toHaveTextContent("Keep this draft");
  await h.user.click(
    screen.getByRole("button", { name: "Cancel reply target" }),
  );
  expect(h.input).toHaveTextContent("Keep this draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});

it("presents the reply immediately and keeps typing available while only Send waits for verification", async () => {
  const h = await fixture();
  const gate = h.pauseTargetRead();
  try {
    await h.user.pointer({ target: h.message, keys: "[MouseLeft>]" });
    await gate.started;
    await h.user.pointer({ keys: "[/MouseLeft]" });
    const composer = screen.getByRole("form", { name: "Reply to thread" });
    expect(within(composer).getByText("Reply target")).toBeVisible();
    expect(within(composer).getByText(/Replying to/)).toBeVisible();
    expect(screen.getByRole("textbox")).toBe(h.input);
    expect(h.input).toHaveAttribute("contenteditable", "true");
    await h.user.type(h.input, "Keep writing while checking");
    expect(h.input).toHaveTextContent("Keep writing while checking");
    expect(
      within(composer).getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    fireEvent.submit(composer);
    await act(async () => {});
    expect(h.publish).not.toHaveBeenCalled();
    const outside = screen.getByRole("button", { name: "Outside control" });
    await h.user.click(outside);
    gate.release();
    await waitFor(() =>
      expect(
        within(composer).getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(outside).toHaveFocus();
    expect(h.input).toHaveTextContent("Keep writing while checking");
  } finally {
    gate.release();
    await h.user.pointer({ keys: "[/MouseLeft]" });
  }
});

it("does not copy another author's agent mentions into an empty inline reply", async () => {
  const h = await fixture({ foreignAgentTarget: true });
  expect(h.input).toHaveTextContent(/^$/);
  await h.hold();
  await act(async () => {});
  expect(h.input).toHaveTextContent(/^$/);
  act(() => h.input.insertText("Reply without notifying an agent"));
  await h.user.keyboard("{Enter}");
  await waitFor(() => expect(h.publish).toHaveBeenCalled());
  const message = h.publish.mock.calls
    .map(([event]) => event)
    .find((event) => event.content === "Reply without notifying an agent");
  expect(message).toBeDefined();
  expect(message?.tags.some(([key]) => key === "p")).toBe(false);
});
