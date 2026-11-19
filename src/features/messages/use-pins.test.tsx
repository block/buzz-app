// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import type { LiveListener } from "../relay/incoming";
import type { PinSource } from "../relay/pins";
import { usePinnedMessages, usePinnedRows } from "./use-pins";

afterEach(cleanup);

const relay = "a".repeat(64),
  author = "c".repeat(64);
const one = "1".repeat(64),
  two = "2".repeat(64);
const message = (id: string, content = id.slice(0, 1)): EventData => ({
  id,
  pubkey: author,
  created_at: 100,
  kind: 9,
  tags: [["h", "c"]],
  content,
});

function source(
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
) {
  const listeners = new Set<LiveListener>();
  const value: PinSource = {
    relayAuthor: relay,
    read: vi.fn(read),
    async readPage(filters, settings) {
      const events = await value.read(filters, settings);
      return { events, relayCount: events.length };
    },
    subscribeLive(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: {
      snapshot: () => ({ heads: [] }),
      subscribe: () => () => {},
    },
  };
  const deliver = (events: EventData[]) => {
    for (const listener of listeners)
      listener({ events } as unknown as Parameters<LiveListener>[0]);
  };
  return { value, deliver };
}

it("reads a failed list once however often its readers render", async () => {
  const s = source(async () => {
    throw new Error("offline");
  });
  const { result, rerender } = renderHook(() =>
    usePinnedMessages(s.value, "c"),
  );
  await waitFor(() => expect(result.current.status).toBe("error"));
  for (let index = 0; index < 5; index++) rerender();
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(s.value.read).toHaveBeenCalledTimes(1);
});

it("keeps only rows the list still names when a reload fails", async () => {
  let fail = false;
  const s = source(async ([filter]) => {
    if (fail) throw new Error("offline");
    return filter?.ids ? filter.ids.map((id) => message(id)) : [];
  });
  const { result, rerender } = renderHook(
    ({ ids }) => usePinnedRows(s.value, "c", ids),
    { initialProps: { ids: [one, two] } },
  );
  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  fail = true;
  rerender({ ids: [one] });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.rows.map((row) => row.id)).toEqual([one]);
});

it("reloads a pinned row when it is edited live", async () => {
  let content = "before";
  const s = source(async ([filter]) => {
    if (filter?.ids) return [message(one)];
    return content === "before"
      ? []
      : [
          {
            ...message("e".repeat(64), content),
            kind: 40003,
            created_at: 101,
            tags: [
              ["h", "c"],
              ["e", one],
            ],
          },
        ];
  });
  const { result } = renderHook(() => usePinnedRows(s.value, "c", [one]));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  content = "after";
  act(() =>
    s.deliver([
      { ...message("f".repeat(64)), kind: 40003, tags: [["e", one]] },
    ]),
  );
  await waitFor(() => expect(result.current.rows[0]?.content).toBe("after"));
  // An edit of another message does not reload.
  const reads = vi.mocked(s.value.read).mock.calls.length;
  act(() =>
    s.deliver([
      { ...message("f".repeat(64)), kind: 40003, tags: [["e", two]] },
    ]),
  );
  expect(vi.mocked(s.value.read).mock.calls.length).toBe(reads);
  // Withdrawing the edit names only the edit, so any deletion in the channel
  // reloads; one in another channel does not.
  content = "before";
  const deletion = (channel: string) => ({
    ...message("9".repeat(64)),
    kind: 5,
    tags: [
      ["h", channel],
      ["e", "e".repeat(64)],
    ],
  });
  act(() => s.deliver([deletion("other")]));
  expect(vi.mocked(s.value.read).mock.calls.length).toBe(reads);
  act(() => s.deliver([deletion("c")]));
  await waitFor(() => expect(result.current.rows[0]?.content).toBe("1"));
});
