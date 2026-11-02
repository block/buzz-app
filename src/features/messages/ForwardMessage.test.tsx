// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { ForwardMessageProvider, useForwardMessage } from "./ForwardMessage";
import { MessageMarkdown } from "./MessageMarkdown";

const viewer = "a".repeat(64),
  recipient = "b".repeat(64),
  messageId = "c".repeat(64);
const scope = `https://relay.example:${viewer}`;
const destination = "11111111-1111-4111-8111-111111111111";
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
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
                  width: 400,
                  height: target.getAttribute("role") === "listbox" ? 400 : 40,
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
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Trigger() {
  const forward = useForwardMessage();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          forward?.({ channelId: "alpha", id: messageId } as ChannelMessage)
        }
      >
        Forward source
      </button>
      <button
        type="button"
        onClick={() =>
          forward?.({
            channelId: "alpha",
            id: "f".repeat(64),
          } as ChannelMessage)
        }
      >
        Forward another
      </button>
    </>
  );
}
function setup() {
  const history = createMemoryHistory();
  const controller = createNavigationController(history);
  const navigation = controller.navigation;
  const complete = () => {
    const state = navigation.snapshot();
    if (state.status === "opening")
      controller.complete(state.attempt, { status: "opened" });
  };
  navigation.subscribe(complete);
  complete();
  void navigation.open({
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    scope: { viewer, communityOrigin: "https://relay.example" },
  });
  stops.push(controller.dispose);
  const channels = { channels: [] },
    profiles = new Map();
  const choices = {
    identities: [] as { pubkey: string; managed: boolean }[],
    pending: false,
  };
  const directMessages = {
    available: true,
    people: vi.fn<RelaySession["directMessages"]["people"]>(async () => ({
      people: [
        { pubkey: recipient, name: "Avery Chen" },
        { pubkey: "d".repeat(64), name: "Morgan Lee" },
      ],
      hasMore: false,
    })),
    open: vi.fn(async () => destination),
    delivered: vi.fn<RelaySession["directMessages"]["delivered"]>(
      async () => {},
    ),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "e".repeat(64)),
  };
  const session = {
    viewer,
    directMessages,
    messages,
    outbox: { ready: async () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    agentChoices: { snapshot: () => choices, subscribe: () => () => {} },
    media: (url: string) => url,
    thread: () => {
      throw new Error("Preview unavailable");
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <ForwardMessageProvider
        session={session}
        scope={scope}
        navigation={navigation}
        renderDialog
      >
        <Trigger />
      </ForwardMessageProvider>
    </ToastProvider>,
  );
  return { navigation, directMessages, messages, choices, profiles };
}
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await screen.findByRole("dialog", { name: "Forward message" });
  await user.click(await screen.findByRole("option", { name: /Avery Chen/ }));
}

it("forwards a note and permalink through the chosen person's DM and retires the completed dialog", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup();
  await choose(user);
  expect(
    screen.getByRole("combobox", { name: "Message recipients" }),
  ).toHaveAttribute("readonly");
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Worth a look",
  );
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(directMessages.open).toHaveBeenCalledWith(
    [recipient],
    expect.any(AbortSignal),
  );
  expect(messages.send).toHaveBeenCalledWith(
    destination,
    `Worth a look\n\nbuzz://message?channel=alpha&id=${messageId}`,
  );
  expect(directMessages.delivered).toHaveBeenCalledWith(
    "e".repeat(64),
    destination,
    expect.any(AbortSignal),
  );
  act(() => navigation.back());
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(1);
});

it("preserves the selection and note across Back/Forward; Cancel retires the visit", async () => {
  const user = userEvent.setup();
  const { navigation, messages } = setup();
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Keep this draft",
  );
  act(() => navigation.back());
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  act(() => navigation.forward());
  expect(
    await screen.findByRole("textbox", { name: "Note (optional)" }),
  ).toHaveValue("Keep this draft");
  expect(
    screen.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => navigation.back());
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).not.toHaveBeenCalled();
});

it("keeps an uncertain send locked and retries its exact event without another DM open or send", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup();
  directMessages.delivered.mockRejectedValueOnce(
    new Error("Delivery could not be confirmed"),
  );
  await choose(user);
  await user.click(screen.getByRole("button", { name: "Forward" }));
  const retry = await screen.findByRole("button", { name: "Retry forward" });
  expect(
    screen.getByRole("textbox", { name: "Note (optional)" }),
  ).toBeDisabled();
  expect(retry).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Forward another" }));
  expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await user.click(
    await screen.findByRole("button", { name: "Retry forward" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(directMessages.open).toHaveBeenCalledTimes(1);
  expect(messages.send).toHaveBeenCalledTimes(1);
  expect(directMessages.delivered).toHaveBeenCalledTimes(2);
  expect(messages.send.mock.calls[0]?.[1]).toBe(
    `buzz://message?channel=alpha&id=${messageId}`,
  );
});

it("retains an editable draft when opening the DM fails", async () => {
  const user = userEvent.setup();
  const { directMessages, messages } = setup();
  directMessages.open.mockRejectedValueOnce(
    new Error("Connection unavailable"),
  );
  await choose(user);
  const note = screen.getByRole("textbox", { name: "Note (optional)" });
  await user.type(note, "Try again");
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByRole("alert");
  expect(note).toBeEnabled();
  expect(note).toHaveValue("Try again");
  expect(messages.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() => expect(messages.send).toHaveBeenCalledTimes(1));
});

it("keeps pending work through passive Back and completes without replay on Forward", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  directMessages.delivered.mockImplementationOnce(() => gate);
  try {
    await choose(user);
    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() =>
      expect(directMessages.delivered).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Note (optional)" }),
    ).toBeDisabled();
    act(() => navigation.back());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Forward message" }),
      ).not.toBeInTheDocument(),
    );
    const signal = directMessages.delivered.mock.calls[0]?.[2];
    await user.click(screen.getByRole("button", { name: "Forward another" }));
    expect(signal?.aborted).toBe(false);
    expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Message forwarded to Avery Chen");
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(1);
});

it("keeps the permalink renderable when a literal note contains an unclosed Markdown fence", async () => {
  const user = userEvent.setup();
  const { messages } = setup();
  await choose(user);
  const note = "```\nPlease check this";
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    note,
  );
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() => expect(messages.send).toHaveBeenCalledTimes(1));
  render(
    <MessageMarkdown
      row={{
        id: "e".repeat(64),
        channelId: destination,
        authorId: viewer,
        content: messages.send.mock.calls[0]?.[1] ?? "",
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      media={() => undefined}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    `buzz://message?channel=alpha&id=${messageId}`,
  );
  expect(screen.getByText(/Please check this/)).toHaveTextContent(
    "``` Please check this",
  );
});

it.each([true, false])(
  "rechecks current DM eligibility after preparation with selected agent metadata=%s",
  async (selectedAgent) => {
    const user = userEvent.setup();
    const { directMessages, messages, choices, profiles } = setup();
    choices.identities = [{ pubkey: recipient, managed: true }];
    directMessages.people.mockResolvedValue({
      people: [
        {
          pubkey: recipient,
          name: "Avery Chen",
          ...(selectedAgent ? { isAgent: true } : {}),
        },
      ],
      hasMore: false,
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    directMessages.open.mockImplementationOnce(async () => {
      await gate;
      return destination;
    });
    try {
      await choose(user);
      await user.click(screen.getByRole("button", { name: "Forward" }));
      await waitFor(() => expect(directMessages.open).toHaveBeenCalledOnce());
      choices.identities = [];
      if (!selectedAgent)
        profiles.set(recipient, { name: "Avery Chen", isAgent: true });
    } finally {
      await act(async () => release());
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer available for direct messages",
    );
    expect(messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  },
);
