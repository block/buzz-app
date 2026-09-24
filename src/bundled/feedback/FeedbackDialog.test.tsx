// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { OutgoingEvent } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { FeedbackDialog } from "./FeedbackDialog";

const subscribe = () => () => {};
const author = keypair();
const pending = (
  delivery: OutgoingEvent["delivery"],
  content = "Saved earlier",
) =>
  ({
    event: signed(author, { kind: 42000, content, tags: [] }),
    delivery,
  }) as OutgoingEvent;
function fixture(
  initialEntries: readonly OutgoingEvent[] = [],
  status: "ready" | "disconnected" = "ready",
) {
  const send = vi.fn();
  const retry = vi.fn();
  const dismiss = vi.fn(async () => {});
  let entries = initialEntries;
  const listeners = new Set<() => void>();
  const outbox = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => entries,
    ready: async () => {},
    supports: () => true,
    send,
    retry,
    dismiss,
  };
  let snapshot: {
    generation: number;
    status: "ready" | "disconnected";
    session: { outbox?: typeof outbox };
  } = { generation: 0, status, session: { outbox } };
  const relayListeners = new Set<() => void>();
  const relay = {
    subscribe(listener: () => void) {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
    snapshot: () => snapshot,
  } as unknown as RelayData;
  return {
    relay,
    send,
    retry,
    dismiss,
    setEntries(next: readonly OutgoingEvent[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
    switchTo(next: typeof snapshot) {
      snapshot = next;
      for (const listener of relayListeners) listener();
    },
  };
}
afterEach(cleanup);

it("publishes trimmed text/category without a channel tag", async () => {
  const user = userEvent.setup();
  const h = fixture();
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.click(screen.getByRole("button", { name: "Bug" }));
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "This broke",
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  expect(h.send).toHaveBeenCalledWith({
    kind: 42000,
    content: "This broke",
    tags: [["category", "bug"]],
  });
});

it("restores outstanding intent and retries only its event id", async () => {
  const user = userEvent.setup();
  const h = fixture([pending("unknown")]);
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  expect(screen.getByText("Saved earlier")).toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Your feedback" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry same feedback" }));
  expect(h.retry).toHaveBeenCalledWith(pending("unknown").event.id);
  expect(h.send).not.toHaveBeenCalled();
});

it("allows confirmed local discard after an unknown retry is rejected", async () => {
  const user = userEvent.setup();
  const saved = pending("unknown");
  const h = fixture([saved]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const view = render(
      <FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Retry same feedback" }),
    );
    expect(h.retry).toHaveBeenCalledWith(saved.event.id);
    act(() =>
      h.setEntries([{ ...saved, delivery: "failed", error: "expired" }]),
    );
    await user.click(screen.getByRole("button", { name: "Discard locally" }));
    expect(h.dismiss).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    h.dismiss.mockImplementationOnce(async () => {
      act(() => h.setEntries([]));
    });
    await user.click(screen.getByRole("button", { name: "Discard locally" }));
    await waitFor(() => expect(h.dismiss).toHaveBeenCalledWith(saved.event.id));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("may already have been delivered"),
    );
    view.unmount();
    render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
    await user.type(
      screen.getByRole("textbox", { name: "Your feedback" }),
      "New feedback",
    );
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(h.send).toHaveBeenCalledWith({
      kind: 42000,
      content: "New feedback",
      tags: [],
    });
  } finally {
    confirm.mockRestore();
  }
});

it("keeps accepted intent on close and clears it only after explicit Done", async () => {
  const user = userEvent.setup();
  const h = fixture([pending("accepted")]);
  const close = vi.fn();
  render(<FeedbackDialog open onOpenChange={close} relay={h.relay} />);
  const closeButton = screen.getAllByRole("button", { name: "Close" }).at(-1);
  if (!closeButton) throw new Error("Missing Close button");
  await user.click(closeButton);
  expect(h.dismiss).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(h.dismiss).toHaveBeenCalledWith(pending("accepted").event.id),
  );
});

it("does not publish or retry while disconnected", async () => {
  const h = fixture([pending("failed")], "disconnected");
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  expect(
    screen.getByRole("button", { name: "Retry same feedback" }),
  ).toBeDisabled();
});

it("drops the previous relay draft on account switch", async () => {
  const user = userEvent.setup();
  const old = fixture();
  render(<FeedbackDialog open onOpenChange={() => {}} relay={old.relay} />);
  await user.click(screen.getByRole("button", { name: "Bug" }));
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Private A",
  );
  const nextEntries: readonly OutgoingEvent[] = [];
  const nextOutbox = {
    subscribe,
    snapshot: () => nextEntries,
    ready: async () => {},
    supports: () => true,
    send: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(async () => {}),
  };
  act(() =>
    old.switchTo({
      generation: 1,
      status: "ready",
      session: { outbox: nextOutbox },
    }),
  );
  expect(screen.getByRole("textbox", { name: "Your feedback" })).toHaveValue(
    "",
  );
  expect(screen.getByRole("button", { name: "Bug" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  expect(old.send).not.toHaveBeenCalled();
});

it("waits for saved feedback hydration before allowing a new send", async () => {
  const user = userEvent.setup();
  const h = fixture();
  let finishLoad!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  const original = h.relay.snapshot();
  const outbox = original.session.outbox;
  if (!outbox) throw new Error("Outbox unavailable");
  const delayed = {
    subscribe,
    snapshot: outbox.snapshot,
    supports: () => true,
    send: h.send,
    retry: h.retry,
    dismiss: h.dismiss,
    ready: () => loaded,
  };
  h.switchTo({ generation: 1, status: "ready", session: { outbox: delayed } });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Before hydration",
  );
  expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  expect(h.send).not.toHaveBeenCalled();
  finishLoad();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeEnabled(),
  );
});

it("renders disconnected personal space without an outbox", () => {
  const h = fixture();
  h.switchTo({ generation: 0, status: "disconnected", session: {} });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
});

it("does not retain a private draft when two deployments share a generation", async () => {
  const user = userEvent.setup();
  const h = fixture();
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Secret A",
  );
  const nextEntries: readonly OutgoingEvent[] = [];
  const nextOutbox = {
    subscribe,
    snapshot: () => nextEntries,
    ready: async () => {},
    supports: () => true,
    send: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(async () => {}),
  };
  act(() =>
    h.switchTo({
      generation: 0,
      status: "ready",
      session: { outbox: nextOutbox },
    }),
  );
  expect(screen.getByRole("textbox", { name: "Your feedback" })).toHaveValue(
    "",
  );
  expect(h.send).not.toHaveBeenCalled();
});

it("does not close a reopened dialog when old Done completes", async () => {
  const user = userEvent.setup();
  const h = fixture([pending("accepted")]);
  let release!: () => void;
  h.dismiss.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const close = vi.fn();
  const view = render(
    <FeedbackDialog open onOpenChange={close} relay={h.relay} />,
  );
  await user.click(screen.getByRole("button", { name: "Done" }));
  view.rerender(
    <FeedbackDialog open={false} onOpenChange={close} relay={h.relay} />,
  );
  view.rerender(<FeedbackDialog open onOpenChange={close} relay={h.relay} />);
  release();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(),
  );
  expect(close).not.toHaveBeenCalled();
});
