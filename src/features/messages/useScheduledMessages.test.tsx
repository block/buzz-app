// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ScheduledMessage,
  ScheduledMessages,
} from "../relay/scheduled-messages";
import { useScheduledMessages } from "./useScheduledMessages";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  let rows: readonly ScheduledMessage[] = [];
  const listeners = new Set<() => void>();
  const service = {
    list: vi.fn(async (_signal: AbortSignal) => rows),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as ScheduledMessages;
  return {
    service,
    listeners,
    setRows(next: readonly ScheduledMessage[]) {
      rows = next;
    },
    change(next: readonly ScheduledMessage[]) {
      rows = next;
      for (const listener of listeners) listener();
    },
  };
}
function View({
  service,
  name,
}: {
  service?: ScheduledMessages;
  name: string;
}) {
  const queue = useScheduledMessages(service);
  return (
    <output aria-label={name}>
      {queue.items.map((item) => item.id).join(",")}
      {queue.loading ? " loading" : ""}
      {queue.error}
    </output>
  );
}
const item = (id: string, sendAt = Date.now() + 60000): ScheduledMessage => ({
  id,
  revision: "1",
  content: "Hello",
  destination: { channelId: "channel", name: "Channel" },
  sendAt,
  status: "scheduled",
});

it("shares loading and invalidation between sidebar and page without extra relay reads", async () => {
  const h = fixture();
  const mounted = render(
    <>
      <View service={h.service} name="sidebar" />
      <View service={h.service} name="page" />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("page").textContent).toBe(""),
  );
  expect(h.service.list).toHaveBeenCalledTimes(1);
  expect(h.listeners.size).toBe(1);
  act(() => h.change([item("queued")]));
  await waitFor(() =>
    expect(screen.getByLabelText("sidebar").textContent).toBe("queued"),
  );
  expect(screen.getByLabelText("page").textContent).toBe("queued");
  expect(h.service.list).toHaveBeenCalledTimes(2);
  // Hold an in-flight read so unmount proves cancellation of live work.
  vi.mocked(h.service.list).mockImplementationOnce(() => new Promise(() => {}));
  act(() => h.change([]));
  mounted.unmount();
  expect(h.listeners.size).toBe(0);
  expect(vi.mocked(h.service.list).mock.calls[2]?.[0].aborted).toBe(true);
});

it("never exposes a previous community's queue while the new one loads", async () => {
  const first = fixture(),
    second = fixture();
  const mounted = render(<View service={first.service} name="queue" />);
  await waitFor(() =>
    expect(screen.getByLabelText("queue").textContent).toBe(""),
  );
  act(() => first.change([item("private-old")]));
  await waitFor(() =>
    expect(screen.getByLabelText("queue").textContent).toBe("private-old"),
  );
  let release!: (rows: readonly ScheduledMessage[]) => void;
  vi.mocked(second.service.list).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  mounted.rerender(<View service={second.service} name="queue" />);
  expect(screen.getByLabelText("queue").textContent).toBe(" loading");
  expect(first.listeners.size).toBe(0);
  await act(async () => release([item("new")]));
  expect(screen.getByLabelText("queue").textContent).toBe("new");
});

it("refreshes once when the nearest scheduled delivery becomes due", async () => {
  vi.useFakeTimers();
  const h = fixture();
  render(
    <>
      <View service={h.service} name="sidebar" />
      <View service={h.service} name="page" />
    </>,
  );
  await act(async () => {});
  await act(async () => h.change([item("due", Date.now() + 10000)]));
  expect(h.service.list).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(12999));
  expect(h.service.list).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.service.list).toHaveBeenCalledTimes(3);
});

it("rechecks overdue messages with backoff until remote delivery clears them", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const h = fixture();
  h.setRows([item("delayed", Date.now() + 10000)]);
  render(<View service={h.service} name="queue" />);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(13000));
  expect(h.service.list).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(h.service.list).toHaveBeenCalledTimes(3);
  h.setRows([]);
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(screen.getByLabelText("queue").textContent).toBe("delayed");
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.service.list).toHaveBeenCalledTimes(4);
  expect(screen.getByLabelText("queue").textContent).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(h.service.list).toHaveBeenCalledTimes(4);
});

it("recovers a failed queue read with the same bounded retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const h = fixture();
  vi.mocked(h.service.list).mockRejectedValueOnce(new Error("Offline"));
  render(<View service={h.service} name="queue" />);
  await act(async () => {});
  expect(screen.getByLabelText("queue").textContent).toBe("Offline");
  h.setRows([item("recovered")]);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByLabelText("queue").textContent).toBe("recovered");
});

it("revalidates an empty queue on the shared long backstop and stops on unmount", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const h = fixture();
  const mounted = render(<View service={h.service} name="sidebar" />);
  await act(async () => {});
  expect(h.service.list).toHaveBeenCalledTimes(1);
  h.setRows([item("remote", Date.now() + 86400000)]);
  await act(async () => vi.advanceTimersByTimeAsync(899999));
  expect(h.service.list).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.service.list).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("sidebar").textContent).toBe("remote");
  mounted.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(1800000));
  expect(h.service.list).toHaveBeenCalledTimes(2);
});
