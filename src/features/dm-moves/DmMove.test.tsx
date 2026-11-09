// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelReference,
  ChannelList,
  ChannelMessage,
} from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { Navigation } from "../navigation/controller";
import { keypair, message, signed } from "../relay/testing";
import {
  controlTemplate,
  moveControl,
  moveState,
  type MoveRequest,
} from "./protocol";
import * as coordinator from "./coordinator";
import { DmMoveCard, DmMoveDialog } from "./DmMove";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture(
  initial: ChannelReference = { state: "unknown" },
  from = false,
) {
  const alice = keypair(),
    bob = keypair();
  const now = Math.floor(Date.now() / 1000);
  const startingMessage: ChannelMessage = {
    id: "a".repeat(64),
    channelId: "dm",
    authorId: alice.pubkey,
    content: "hello",
    createdAt: now - 10,
    attachments: [],
    mentions: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
  const request: MoveRequest = {
    type: "request",
    move: "e44c7b53-42b2-4c5e-8051-fce508998b96",
    worker: "e44c7b53-42b2-4c5e-8051-fce508998b97",
    target: "target",
    expires: now + 86400,
    authors: [
      [alice.pubkey, alice.pubkey],
      [bob.pubkey, bob.pubkey],
    ],
    ...(from
      ? {
          from: {
            id: startingMessage.id,
            ms: startingMessage.createdAt * 1000,
          },
        }
      : {}),
  };
  const event = signed(alice, {
    ...controlTemplate("dm", request),
    created_at: now,
  });
  const record = moveControl(event);
  if (!record) throw new Error("Invalid request fixture");
  const snapshot: coordinator.MoveSnapshot = {
    loading: false,
    moves: [moveState({ ...record, control: request }, [record], now)],
  };
  const respond = vi.fn(async () => {});
  vi.spyOn(coordinator, "dmMoves").mockReturnValue({
    snapshot: () => snapshot,
    subscribe: () => () => {},
    respond,
  } as unknown as coordinator.DmMoves);
  let reference = initial;
  const listeners = new Set<() => void>();
  const release = vi.fn();
  const refer = vi.fn(() => release);
  const list: ChannelList = { status: "ready", channels: [] };
  const sourceReference: ChannelReference = {
    state: "found",
    name: "Alice and Bob",
    description: "",
    channelType: "dm",
    private: true,
    hidden: true,
    archived: false,
    joined: true,
  };
  const profiles = new Map([[alice.pubkey, { name: "Alice" }]]);
  const threadSnapshot = {
    status: "ready",
    root: startingMessage,
    target: startingMessage,
    targetStatus: "ready",
    replies: [],
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const thread = vi.fn(() => ({
    snapshot: () => threadSnapshot,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    dispose: vi.fn(),
  }));
  const open = vi.fn();
  const session = {
    scope: `https://community.test:${bob.pubkey}`,
    viewer: bob.pubkey,
    thread,
    media: (url: string) => url,
    channels: {
      list: () => list,
      get: (id: string) =>
        id === "dm"
          ? { id: "dm", name: "Alice and Bob", channelType: "dm" }
          : undefined,
      describe: (id: string) => (id === "dm" ? sourceReference : reference),
      refer,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  render(
    <DmMoveCard
      session={session}
      message={{ dmMove: event.id } as ChannelMessage}
      navigation={{ open } as unknown as Navigation}
    />,
  );
  return {
    event,
    respond,
    refer,
    release,
    startingMessage,
    thread,
    open,
    answer(next: ChannelReference) {
      act(() => {
        reference = next;
        for (const listener of listeners) listener();
      });
    },
  };
}

it("names an unjoined public destination before allowing approval", () => {
  const f = fixture();
  expect(f.refer).toHaveBeenCalledWith("target");
  expect(screen.getByText("Loading destination…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  f.answer({
    state: "found",
    name: "launch-planning",
    description: "",
    channelType: "stream",
    private: false,
    hidden: false,
    archived: false,
    joined: false,
  });
  expect(
    screen.getByRole("region", { name: "Convert DM to #launch-planning" }),
  ).toBeVisible();
  const approve = screen.getByRole("button", { name: "Approve" });
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  expect(f.respond).toHaveBeenCalledWith(f.event.id, true);
});

it("keeps an unavailable destination unapprovable while allowing a decline", () => {
  fixture({ state: "withheld" });
  expect(
    screen.getByText("The destination channel is unavailable."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
});

it("shows the recipient the exact starting message, author and time, with a link to its original DM", async () => {
  const f = fixture(
    {
      state: "found",
      name: "team",
      description: "",
      channelType: "stream",
      private: false,
      hidden: false,
      archived: false,
      joined: true,
    },
    true,
  );
  expect(await screen.findByText("hello", { exact: true })).toBeVisible();
  expect(screen.getByText("Alice", { exact: true })).toBeVisible();
  expect(document.querySelector("time")).toHaveAttribute(
    "datetime",
    new Date(f.startingMessage.createdAt * 1000).toISOString(),
  );
  expect(f.thread).toHaveBeenCalledWith("dm", f.startingMessage.id, {
    exact: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "View message" }));
  expect(f.open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "dm",
      messageId: f.startingMessage.id,
    }),
  );
});

it.each(["all", "from", "reply"] as const)(
  "%s entry keeps its fixed range and validates the source boundary",
  async (entry) => {
    const user = userEvent.setup();
    const selected = message(
      keypair(),
      "dm",
      "Start here",
      100,
      entry === "reply" ? [["e", "b".repeat(64), "", "reply"]] : [],
    );
    let resolveSource!: (events: (typeof selected)[]) => void;
    const readRemote = vi.fn(
      () =>
        new Promise<(typeof selected)[]>((resolve) => {
          resolveSource = resolve;
        }),
    );
    const start = vi.fn(async () => "request");
    const snapshot = { loading: false, moves: [] };
    vi.spyOn(coordinator, "dmMoves").mockReturnValue({
      snapshot: () => snapshot,
      subscribe: () => () => {},
      start,
    } as unknown as coordinator.DmMoves);
    const list: ChannelList = {
      status: "ready",
      channels: [
        {
          id: "target",
          name: "team",
          channelType: "stream",
          visibility: "public",
        },
      ],
    };
    const session = {
      channels: { list: () => list, subscribeList: () => () => {} },
      readRemote,
    } as unknown as RelaySession;
    const close = vi.fn();
    render(
      <DmMoveDialog
        session={session}
        channelId="dm"
        fromId={entry === "all" ? "all" : selected.id}
        close={close}
      />,
    );
    expect(
      screen.getByText(
        entry === "all" ? "Whole conversation" : "From this message onward",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Messages" }),
    ).not.toBeInTheDocument();
    const submit = () =>
      screen.getByRole("button", { name: "Request approval" });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    await user.hover(submit());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Choose a destination channel first.",
    );
    await user.click(submit());
    expect(start).not.toHaveBeenCalled();
    await user.unhover(submit());
    await user.click(screen.getByRole("combobox", { name: "Channel" }));
    await user.click(await screen.findByRole("option", { name: "#team" }));
    if (entry !== "all") {
      expect(submit()).toHaveAttribute("aria-disabled", "true");
      await user.hover(submit());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Loading the starting message…",
      );
      await user.unhover(submit());
      expect(readRemote).toHaveBeenCalledWith(
        [{ kinds: [9, 40002], ids: [selected.id], "#h": ["dm"], limit: 1 }],
        { signal: expect.any(AbortSignal) },
      );
      await act(async () => resolveSource([selected]));
      if (entry === "reply") {
        await user.hover(submit());
        expect(await screen.findByRole("tooltip")).toHaveTextContent(
          "Conversion cannot start from a thread reply. Choose a message in the main DM.",
        );
        await user.click(submit());
        expect(start).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        return;
      }
    } else {
      expect(readRemote).not.toHaveBeenCalled();
    }
    await waitFor(() =>
      expect(submit()).not.toHaveAttribute("aria-disabled", "true"),
    );
    const hours = screen.getByRole("spinbutton", {
      name: "Approval window (hours)",
    });
    fireEvent.change(hours, { target: { value: "0" } });
    await user.hover(submit());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Choose an approval window between one minute and 30 days.",
    );
    await user.click(submit());
    expect(start).not.toHaveBeenCalled();
    await user.unhover(submit());
    fireEvent.change(hours, { target: { value: "24" } });
    await user.click(submit());
    expect(start).toHaveBeenCalledWith(
      "dm",
      "target",
      24,
      entry === "from" ? { id: selected.id, ms: 100000 } : undefined,
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  },
);
