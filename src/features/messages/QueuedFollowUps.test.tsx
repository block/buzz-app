// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { AgentsContext } from "../agents/react";
import type { Agents } from "../agents/service";
import { followUpQueue } from "./follow-up-queue";
import { QueuedFollowUps } from "./QueuedFollowUps";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture() {
  const listeners = new Set<() => void>();
  let state = "working";
  const session = {
    channels: { list: () => ({ channels: [{ id: "chat" }] }) },
    agentActivity: {
      activate: () => () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => ({
        status: "listening",
        turns: [],
        local: [
          {
            agent: "agent",
            messageId: "old",
            channelId: "chat",
            state,
          },
        ],
      }),
    },
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  const add = (text: string, beforeRelease?: () => Promise<void>) => {
    const publish = vi.fn(() => text);
    queue.submit({
      text,
      channelId: "chat",
      recipients: ["agent"],
      publish,
      ...(beforeRelease ? { beforeRelease } : {}),
    });
    return publish;
  };
  function mount(agents?: Agents, agentName?: (pubkey: string) => string) {
    render(
      <AgentsContext.Provider value={agents}>
        <input aria-label="Composer" />
        <button type="button">Elsewhere</button>
        <QueuedFollowUps
          session={session}
          channelId="chat"
          disabled={false}
          focusComposer={() => screen.getByRole("textbox").focus()}
          {...(agentName ? { agentName } : {})}
        />
      </AgentsContext.Provider>,
    );
  }
  return {
    queue,
    add,
    mount,
    finish() {
      state = "done";
      for (const listener of listeners) listener();
    },
  };
}
it("keeps queued Send focused when compaction finishes, then sends with Enter", async () => {
  const h = fixture();
  const publish = h.add("first");
  const listeners = new Set<() => void>();
  const types: readonly never[] = [];
  let compacting = true;
  const agents = {
    types: () => types,
    find: (pubkey: string) => ({ key: pubkey }),
    sessionState: () => (compacting ? "compacting" : "idle"),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Agents;
  h.mount(agents);
  const user = userEvent.setup();
  const send = screen.getByRole("button", { name: "Send now" });
  send.focus();
  expect(send).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Enter}");
  expect(publish).not.toHaveBeenCalled();
  act(() => {
    compacting = false;
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("button", { name: "Send now" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(publish).toHaveBeenCalledOnce();
});
it("restores focus to a remaining row and then the composer after keyboard removal", async () => {
  const h = fixture();
  h.add("first");
  h.add("second");
  h.mount();
  const user = userEvent.setup();
  screen.getAllByRole("button", { name: "Remove queued message" })[0]?.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Remove queued message" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("textbox")).toHaveFocus();
});
it("keeps focus on failed Send and restores it after successful retry", async () => {
  const h = fixture();
  const publish = h.add("first");
  publish.mockImplementationOnce(() => {
    throw new Error("Unavailable");
  });
  h.mount();
  const user = userEvent.setup();
  const send = screen.getByRole("button", { name: "Send now" });
  send.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(send).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("textbox")).toHaveFocus();
});
it("does not steal focus moved outside a row during validation", async () => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const h = fixture();
  h.add("first", () => gate);
  h.mount();
  const user = userEvent.setup();
  const send = within(screen.getByRole("region")).getByRole("button", {
    name: "Send now",
  });
  send.focus();
  await user.keyboard("{Enter}");
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  await act(async () => {
    resume();
    await gate;
  });
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("preserves Send focus so consecutive Enter presses send both queued messages", async () => {
  const h = fixture();
  const first = h.add("first");
  const second = h.add("second");
  h.mount();
  const user = userEvent.setup();
  screen.getAllByRole("button", { name: "Send now" })[0]?.focus();
  await user.keyboard("{Enter}");
  expect(first).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Send now" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(second).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("toggles multiline requests while short requests remain non-expandable", async () => {
  const h = fixture();
  h.add("Short request");
  h.add("First line\nSecond line");
  h.mount();
  const short = screen.getByRole("button", { name: "Short request" });
  const long = screen.getByRole("button", { name: /First line\s+Second line/ });
  expect(short).toHaveAttribute("tabindex", "-1");
  await userEvent.click(short);
  expect(short).not.toHaveAttribute("aria-expanded");
  expect(long).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(long);
  expect(long).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(long);
  expect(long).toHaveAttribute("aria-expanded", "false");
});

it("restores preview focus after automatic release, then returns to the composer", async () => {
  const h = fixture();
  const first = h.add("First\nrequest");
  h.add("Second\nrequest");
  h.mount();
  screen.getByRole("button", { name: /First\s+request/ }).focus();
  await act(async () => h.finish());
  expect(first).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: /Second\s+request/ }),
  ).toHaveFocus();
  const remaining = h.queue.snapshot()[0];
  if (!remaining) throw new Error("Expected a remaining queued request");
  act(() => h.queue.remove(remaining.id));
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("does not steal external focus when a previously focused preview releases", async () => {
  const h = fixture();
  h.add("First\nrequest");
  h.mount();
  screen.getByRole("button", { name: /First\s+request/ }).focus();
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  await act(async () => h.finish());
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("shows a Stop pause, keeps rows held, and releases them with Resume queue", async () => {
  const h = fixture();
  const first = h.add("first");
  const second = h.add("second");
  h.mount();
  await act(() => h.queue.pause("chat"));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Queued (2) · paused after Stop",
  );
  act(() => h.finish());
  expect(first).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Resume queue" }));
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps keyboard focus in the chat when Resume queue is pressed with Enter", async () => {
  const h = fixture();
  h.add("first");
  h.add("second");
  h.mount();
  await act(() => h.queue.pause("chat"));
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Resume queue" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", { name: "Resume queue" })).toBeNull();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("explains Send now in its tooltip, naming the agent", async () => {
  const h = fixture();
  h.add("first");
  h.mount(undefined, () => "Bestie");
  const user = userEvent.setup();
  await user.hover(screen.getByRole("button", { name: "Send now" }));
  expect(
    await screen.findByText(
      "Send now. If Bestie is busy, it may add this to its current task.",
    ),
  ).toBeInTheDocument();
});

it("keeps the compaction explanation on a disabled Send now", async () => {
  const h = fixture();
  h.add("first");
  const types: readonly never[] = [];
  const agents = {
    types: () => types,
    find: (pubkey: string) => ({ key: pubkey }),
    sessionState: () => "compacting",
    subscribe: () => () => {},
  } as unknown as Agents;
  h.mount(agents, () => "Bestie");
  const user = userEvent.setup();
  await user.hover(screen.getByRole("button", { name: "Send now" }));
  expect(
    await screen.findByText("Wait for compaction to finish, or interrupt it."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/If Bestie is busy/)).toBeNull();
});
