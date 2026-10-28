// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useOpenedSession, useOpenTranscript } from "./OpenedConversation";

type Row = { key: string; channelId: string; root?: string };
const conversation = { channelId: "channel", rootId: "root" };
const recent: Row = { key: "recent", channelId: "other" };
const found: Row = { key: "found", channelId: "channel", root: "root" };
// One request keeps one `done` across renders; a new one is a new request.
const settled = () => {};

it("keeps the reader's choice when the opened conversation's lookup finishes later", async () => {
  let resolve: (row: Row) => void = () => {};
  const lookup = new Promise<Row>((done) => {
    resolve = done;
  });
  const { result } = renderHook(() => {
    const { session } = useOpenedSession<Row>(
      [recent],
      conversation,
      () => lookup,
    );
    return useOpenTranscript<Row>(conversation, (row) => row.key, {
      initial: session,
      done: settled,
    });
  });
  expect(result.current.open).toBeUndefined();
  act(() => result.current.show(recent));
  try {
    expect(result.current.open).toBe(recent);
  } finally {
    await act(async () => resolve(found));
  }
  expect(result.current.open).toBe(recent);
});

it("never opens a transcript found only after the conversation was shown", async () => {
  const done = vi.fn();
  const { result } = renderHook(() => {
    const { session } = useOpenedSession<Row>(
      [recent],
      conversation,
      async () => found,
    );
    return useOpenTranscript<Row>(conversation, (row) => row.key, {
      initial: session,
      done,
    });
  });
  await act(async () => {});
  expect(result.current.open).toBeUndefined();
  expect(done).toHaveBeenCalled();
});

it("opens the known conversation's transcript once, not again after Back", () => {
  const { result } = renderHook(() => {
    const { session } = useOpenedSession<Row>(
      [found],
      conversation,
      async () => undefined,
    );
    return useOpenTranscript<Row>(conversation, (row) => row.key, {
      initial: session,
      done: settled,
    });
  });
  expect(result.current.open).toBe(found);
  act(() => result.current.back());
  expect(result.current.open).toBeUndefined();
});

it("opens the transcript again for a new request in the same conversation", () => {
  const { result, rerender } = renderHook(
    ({ done }: { done: (() => void) | undefined }) => {
      const { session } = useOpenedSession<Row>(
        [found],
        conversation,
        async () => undefined,
      );
      return useOpenTranscript<Row>(
        conversation,
        (row) => row.key,
        done && { initial: session, done },
      );
    },
    { initialProps: { done: settled as (() => void) | undefined } },
  );
  expect(result.current.open).toBe(found);
  act(() => result.current.back());
  // Offered and settled: rendering on without a request leaves it closed.
  rerender({ done: undefined });
  expect(result.current.open).toBeUndefined();
  const again = vi.fn();
  rerender({ done: again });
  expect(result.current.open).toBe(found);
  expect(again).toHaveBeenCalledOnce();
  // The same request, rendered again after Back, does not reopen it.
  act(() => result.current.back());
  rerender({ done: again });
  expect(result.current.open).toBeUndefined();
});
