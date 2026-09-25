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
import type { RelayData } from "../../features/relay/service";
import type { OutgoingEvent } from "../../features/relay/outbox";
import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "../../features/relay/budget";
import { feedbackEvent } from "../../features/relay/product-feedback";
import { keypair, signed } from "../../features/relay/testing";
import { FeedbackDialog } from "./FeedbackDialog";
import { feedbackDiagnostics } from "./prepare-feedback";

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
  const upload = vi.fn();
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
    session: {
      outbox?: typeof outbox;
      feedbackUpload?: { origin: string; upload: typeof upload } | undefined;
    };
  } = {
    generation: 0,
    status,
    session: {
      outbox,
      feedbackUpload: { origin: "https://relay.test", upload },
    },
  };
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
    upload,
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
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "will not undo delivery or delete uploaded attachments",
      ),
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

it("keeps saved feedback available when local dismissal fails", async () => {
  const user = userEvent.setup();
  const saved = pending("unknown");
  const h = fixture([saved]);
  const close = vi.fn();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  h.dismiss.mockRejectedValueOnce(new Error("Storage unavailable"));
  try {
    render(<FeedbackDialog open onOpenChange={close} relay={h.relay} />);
    await user.click(screen.getByRole("button", { name: "Discard locally" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage unavailable",
    );
    expect(screen.getByText("Saved earlier")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(h.dismiss).toHaveBeenCalledWith(saved.event.id);
    expect(
      screen.getByRole("button", { name: "Retry same feedback" }),
    ).toBeEnabled();
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
      session: { outbox: nextOutbox, feedbackUpload: undefined },
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
  h.switchTo({
    generation: 1,
    status: "ready",
    session: { outbox: delayed, feedbackUpload: undefined },
  });
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
  const closeButton = screen.getAllByRole("button", { name: "Close" }).at(-1);
  if (!closeButton) throw new Error("Missing Close button");
  await user.click(closeButton);
  view.rerender(
    <FeedbackDialog open={false} onOpenChange={close} relay={h.relay} />,
  );
  view.rerender(<FeedbackDialog open onOpenChange={close} relay={h.relay} />);
  close.mockClear();
  release();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(),
  );
  expect(close).not.toHaveBeenCalled();
});

it("does not offer attachments when the session has no upload capability", () => {
  const h = fixture();
  const entries: readonly OutgoingEvent[] = [];
  const outbox = {
    subscribe,
    snapshot: () => entries,
    ready: async () => {},
    supports: () => true,
    send: h.send,
    retry: h.retry,
    dismiss: h.dismiss,
  };
  h.switchTo({
    generation: 0,
    status: "ready",
    session: { outbox, feedbackUpload: undefined },
  });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  expect(
    screen.queryByLabelText("Attach image (optional)"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Attach diagnostics" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      /Images and optional diagnostics use ordinary media storage/,
    ),
  ).toBeInTheDocument();
  expect(h.upload).not.toHaveBeenCalled();
});

const hash = "a".repeat(64);
const uploaded = (name: string, type: string, ext: string) => ({
  name,
  type,
  size: 64,
  sha256: hash,
  url: `https://relay.test/media/${hash}.${ext}`,
});

it("ignores an image upload completed after closing", async () => {
  const user = userEvent.setup();
  const h = fixture();
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.upload.mockImplementationOnce((_file) => {
    started();
    return new Promise((resolve) => {
      release = () => resolve(uploaded("screen.gif", "image/gif", "gif"));
    });
  });
  const close = vi.fn();
  render(<FeedbackDialog open onOpenChange={close} relay={h.relay} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Attach image (optional)")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Attach image (optional)"), {
    target: {
      files: [
        new File(
          [
            new Uint8Array([
              71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 0x21, 0xf9, 4, 0, 10,
              0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
            ]),
          ],
          "screen.gif",
          { type: "image/gif" },
        ),
      ],
    },
  });
  await began;
  const signal = h.upload.mock.calls[0]?.[1] as AbortSignal;
  const closeButton = screen.getAllByRole("button", { name: "Close" }).at(-1);
  if (!closeButton) throw new Error("Missing Close button");
  await user.click(closeButton);
  expect(signal.aborted).toBe(true);
  release();
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(screen.queryByText(/Image uploaded/)).not.toBeInTheDocument();
  expect(h.send).not.toHaveBeenCalled();
});

it("uploads an image before submission and retries the signed intent without another upload", async () => {
  const user = userEvent.setup();
  const h = fixture();
  h.upload.mockResolvedValue(uploaded("screen.gif", "image/gif", "gif"));
  const view = render(
    <FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Attach image (optional)")).toBeEnabled(),
  );
  await user.upload(
    screen.getByLabelText("Attach image (optional)"),
    new File(
      [
        new Uint8Array([
          71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 0x21, 0xf9, 4, 0, 10, 0,
          0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
        ]),
      ],
      "screen.gif",
      { type: "image/gif" },
    ),
  );
  await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByText(/Image uploaded/)).toBeInTheDocument(),
  );
  expect(h.send).not.toHaveBeenCalled();
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Image failed",
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 42000,
      tags: [
        expect.arrayContaining([
          "imeta",
          `url https://relay.test/media/${hash}.gif`,
        ]),
      ],
    }),
  );
  view.unmount();
  const signedIntent = pending("unknown", "Image failed");
  const restored = fixture([signedIntent]);
  render(
    <FeedbackDialog open onOpenChange={() => {}} relay={restored.relay} />,
  );
  await user.click(screen.getByRole("button", { name: "Retry same feedback" }));
  expect(restored.retry).toHaveBeenCalledWith(signedIntent.event.id);
  expect(restored.upload).not.toHaveBeenCalled();
  expect(h.upload).toHaveBeenCalledTimes(1);
});

it("cancels opted-in diagnostics upload on close without sending", async () => {
  const user = userEvent.setup();
  const h = fixture();
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    h.upload.mockImplementationOnce((_file, signal) => {
      expect(signal.aborted).toBe(false);
      resolve();
      return new Promise((done) => {
        release = () =>
          done(
            uploaded(
              "feedback-diagnostics.txt",
              "application/octet-stream",
              "bin",
            ),
          );
      });
    });
  });
  const close = vi.fn();
  const view = render(
    <FeedbackDialog open onOpenChange={close} relay={h.relay} />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Broken",
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await started;
  expect(h.send).not.toHaveBeenCalled();
  const closeButton = screen.getAllByRole("button", { name: "Close" }).at(-1);
  if (!closeButton) throw new Error("Missing close button");
  await user.click(closeButton);
  release();
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(h.send).not.toHaveBeenCalled();
  view.unmount();
});

it("locks the captured draft while diagnostics upload before sending", async () => {
  const user = userEvent.setup();
  const h = fixture();
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    h.upload.mockImplementationOnce(() => {
      resolve();
      return new Promise((done) => {
        release = () =>
          done(
            uploaded(
              "feedback-diagnostics.txt",
              "application/octet-stream",
              "bin",
            ),
          );
      });
    });
  });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  const textbox = screen.getByRole("textbox", { name: "Your feedback" });
  await user.click(screen.getByRole("button", { name: "Bug" }));
  await user.type(textbox, "Original");
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  try {
    await started;
    expect(textbox).toBeDisabled();
    for (const name of ["Bug", "Praise", "Needs work"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.send.mock.calls[0]?.[0]).toMatchObject(
    feedbackEvent(
      "Original",
      "bug",
      [uploaded("feedback-diagnostics.txt", "application/octet-stream", "bin")],
      "https://relay.test",
    ),
  );
});

it("uploads diagnostics only on explicit opt-in and sends a text-file descriptor", async () => {
  const user = userEvent.setup();
  const h = fixture();
  h.upload.mockResolvedValue(
    uploaded("feedback-diagnostics.txt", "application/octet-stream", "bin"),
  );
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "A problem",
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  const file = h.upload.mock.calls[0]?.[0] as File | undefined;
  expect(file?.name).toBe("feedback-diagnostics.txt");
  expect(file?.type).toBe("text/plain");
  expect(await file?.text()).toContain("app version:");
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("feedback-diagnostics.txt"),
      tags: [expect.arrayContaining(["m application/octet-stream"])],
    }),
  );
});

it("preflights serialized diagnostics input before uploading", async () => {
  const user = userEvent.setup();
  const h = fixture();
  const descriptor = uploaded(
    "feedback-diagnostics.txt",
    "application/octet-stream",
    "abcdefgh",
  );
  h.upload.mockResolvedValue(descriptor);
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.click(screen.getByRole("button", { name: "Bug" }));
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  // The placeholder reserves the longest URL and MIME with the generated file size.
  const diagnostics = await feedbackDiagnostics();
  const placeholder = {
    ...descriptor,
    size: diagnostics.size,
    sha256: "0".repeat(64),
    url: `https://relay.test/media/${"0".repeat(64)}.abcdefgh`,
  };
  let low = 1;
  let high = OUTBOX_INPUT_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try {
      feedbackEvent(
        '"'.repeat(middle),
        "bug",
        [placeholder],
        "https://relay.test",
      );
      low = middle;
    } catch {
      high = middle - 1;
    }
  }
  const boundary = '"'.repeat(low);
  fireEvent.change(screen.getByRole("textbox", { name: "Your feedback" }), {
    target: { value: `${boundary}"` },
  });
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Feedback must contain text and fit within relay limits.",
  );
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  expect(
    byteSize(
      feedbackEvent(boundary, "bug", [placeholder], "https://relay.test"),
    ),
  ).toBeLessThanOrEqual(OUTBOX_INPUT_MAX_BYTES);
  fireEvent.change(screen.getByRole("textbox", { name: "Your feedback" }), {
    target: { value: boundary },
  });
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(byteSize(h.send.mock.calls[0]?.[0])).toBeLessThanOrEqual(
    OUTBOX_INPUT_MAX_BYTES,
  );
});

it("rejects diagnostics content overflow before uploading", async () => {
  const user = userEvent.setup();
  const h = fixture();
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  const descriptor = uploaded(
    "feedback-diagnostics.txt",
    "application/octet-stream",
    "abcdefgh",
  );
  const remaining =
    32 * 1024 -
    feedbackEvent("a", null, [descriptor], "https://relay.test").content
      .length +
    1;
  fireEvent.change(screen.getByRole("textbox", { name: "Your feedback" }), {
    target: { value: "x".repeat(remaining + 1) },
  });
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Feedback must contain text and fit within relay limits.",
  );
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});

it("reuses an uploaded diagnostics descriptor after a failed send", async () => {
  const user = userEvent.setup();
  const h = fixture();
  h.upload.mockResolvedValue(
    uploaded("feedback-diagnostics.txt", "application/octet-stream", "bin"),
  );
  h.send.mockImplementationOnce(() => {
    throw new Error("send failed");
  });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "A problem",
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await screen.findByRole("alert");
  expect(h.upload).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(h.upload).toHaveBeenCalledOnce();
});

it("discards an in-flight diagnostics result on relay generation switch", async () => {
  const user = userEvent.setup();
  const h = fixture();
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.upload.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      release = () =>
        resolve(
          uploaded(
            "feedback-diagnostics.txt",
            "application/octet-stream",
            "bin",
          ),
        );
    });
  });
  render(<FeedbackDialog open onOpenChange={() => {}} relay={h.relay} />);
  await user.type(
    screen.getByRole("textbox", { name: "Your feedback" }),
    "Private A",
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Attach diagnostics" }),
  );
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await began;
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
      generation: 1,
      status: "ready",
      session: { outbox: nextOutbox, feedbackUpload: undefined },
    }),
  );
  release();
  expect(screen.getByRole("textbox", { name: "Your feedback" })).toHaveValue(
    "",
  );
  expect(h.send).not.toHaveBeenCalled();
});
