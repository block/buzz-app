// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useOpenedSession, useOpenTranscript } from "./OpenedConversation";

type Row = { key: string; channelId: string; root?: string };
const conversation = { channelId: "channel", rootId: "root" };
const recent: Row = { key: "recent", channelId: "other" };
const found: Row = { key: "found", channelId: "channel", root: "root" };

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
      opening: 1,
      done() {},
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

it("opens a transcript its lookup finds after the conversation was shown, once", async () => {
  let resolve: (row: Row) => void = () => {};
  const lookup = new Promise<Row>((done) => {
    resolve = done;
  });
  const done = vi.fn();
  const { result } = renderHook(() => {
    const { session, searching } = useOpenedSession<Row>(
      [recent],
      conversation,
      () => lookup,
    );
    return useOpenTranscript<Row>(conversation, (row) => row.key, {
      initial: session,
      searching,
      opening: 1,
      done,
    });
  });
  try {
    expect(result.current.open).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
  } finally {
    await act(async () => resolve(found));
  }
  expect(result.current.open).toEqual(found);
  expect(done).toHaveBeenCalledTimes(1);
  act(() => result.current.back());
  expect(result.current.open).toBeUndefined();
});

it("keeps the overview when the reader types or clicks before the lookup finishes", async () => {
  for (const input of ["keydown", "pointerdown"] as const) {
    let resolve: (row: Row) => void = () => {};
    const lookup = new Promise<Row>((done) => {
      resolve = done;
    });
    const done = vi.fn();
    const { result, unmount } = renderHook(() => {
      const { session, searching } = useOpenedSession<Row>(
        [recent],
        conversation,
        () => lookup,
      );
      return useOpenTranscript<Row>(conversation, (row) => row.key, {
        initial: session,
        searching,
        opening: 1,
        done,
      });
    });
    try {
      act(() => void document.body.dispatchEvent(new Event(input)));
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => resolve(found));
    }
    expect(result.current.open).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
    unmount();
  }
});

it("settles without opening when the lookup finds no session", async () => {
  const done = vi.fn();
  const { result } = renderHook(() => {
    const { session, searching } = useOpenedSession<Row>(
      [recent],
      conversation,
      async () => undefined,
    );
    return useOpenTranscript<Row>(conversation, (row) => row.key, {
      initial: session,
      searching,
      opening: 1,
      done,
    });
  });
  await act(async () => {});
  expect(result.current.open).toBeUndefined();
  expect(done).toHaveBeenCalledTimes(1);
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
      opening: 1,
      done() {},
    });
  });
  expect(result.current.open).toBe(found);
  act(() => result.current.back());
  expect(result.current.open).toBeUndefined();
});

it("opens the transcript again for a new opening in the same conversation", () => {
  const settled = vi.fn();
  const { result, rerender } = renderHook(
    ({ opening }: { opening: number | undefined }) => {
      const { session } = useOpenedSession<Row>(
        [found],
        conversation,
        async () => undefined,
      );
      // A callback made anew each render, as an inline one is.
      return useOpenTranscript<Row>(
        conversation,
        (row) => row.key,
        opening === undefined
          ? undefined
          : { initial: session, opening, done: () => settled(opening) },
      );
    },
    { initialProps: { opening: 1 as number | undefined } },
  );
  expect(result.current.open).toBe(found);
  act(() => result.current.back());
  rerender({ opening: 1 });
  expect(result.current.open).toBeUndefined();
  // Offered and settled: rendering on without a request leaves it closed.
  rerender({ opening: undefined });
  expect(result.current.open).toBeUndefined();
  rerender({ opening: 2 });
  expect(result.current.open).toBe(found);
  // The same opening, rendered again after Back, does not reopen it.
  act(() => result.current.back());
  rerender({ opening: 2 });
  expect(result.current.open).toBeUndefined();
  expect(settled.mock.calls).toEqual([[1], [2]]);
});
