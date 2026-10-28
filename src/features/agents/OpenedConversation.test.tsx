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
      done() {},
    });
  });
  expect(result.current.open).toBe(found);
  act(() => result.current.back());
  expect(result.current.open).toBeUndefined();
});
