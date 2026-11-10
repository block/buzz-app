// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import { eventDto, type EventData } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { bounds, keypair, message, metadata } from "../relay/testing";
import { useSoloForkLock } from "./useSoloForkLock";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const channel: ChannelSummary = {
  id,
  name: "Chat",
  channelType: "solo",
  forkClaim: true,
};
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const owner = createRelaySession(null);
  dispose.push(owner.dispose);
  const relay = keypair();
  const cutoff = eventDto(message(keypair(), other, "Inherited", 10));
  const meta = (target = id, extra?: string[][]) =>
    eventDto(
      metadata(
        relay,
        target,
        "Chat",
        undefined,
        extra ?? (target === id ? [["forked_from", other, cutoff.id]] : []),
      ),
    );
  const read = vi.fn<typeof owner.session.read>(async (filters) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(39000)) return [meta(filter["#d"]?.[0])];
    if (filter?.ids) return [cutoff];
    const target = filter?.["#h"]?.[0] ?? id;
    const cursor = filter?.before_id
      ? `${filter.until}:${filter.before_id}`
      : "head";
    return [
      ...(target === other ? [cutoff] : []),
      eventDto(
        bounds(relay, target, cursor, { has_more: false, next_cursor: null }),
      ),
    ];
  });
  const starting = vi.fn((_id: string): Promise<void> | undefined => undefined);
  const session = {
    ...owner.session,
    relayAuthor: relay.pubkey,
    read,
    channelWrites: { ...owner.session.channelWrites, starting },
  };
  return { session, read, starting, meta, relay, cutoff };
}

it("waits for local creation and verified fork metadata before enabling", async () => {
  const h = setup();
  const create = deferred<void>();
  const metadataRead = deferred<readonly EventData[]>();
  h.starting.mockReturnValue(create.promise);
  h.read.mockReturnValueOnce(metadataRead.promise);
  const mounted = renderHook(
    ({ current }) => useSoloForkLock(h.session, current),
    {
      initialProps: { current: channel },
    },
  );
  try {
    expect(mounted.result.current.disabled).toBe(true);
    expect(h.starting).toHaveBeenCalledWith(id);
    expect(h.read).not.toHaveBeenCalled();
    await act(async () => create.resolve());
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(mounted.result.current.disabled).toBe(true);
    await act(async () => metadataRead.resolve([h.meta()]));
    await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
    expect(h.read.mock.calls[0]).toEqual([
      [
        {
          kinds: [39000],
          authors: [h.relay.pubkey],
          "#d": [id],
          limit: 1,
          consistency: "strong",
        },
      ],
      expect.objectContaining({ fresh: true, signal: expect.any(AbortSignal) }),
    ]);
    mounted.rerender({
      current: { id, name: "Ordinary", channelType: "solo" },
    });
    expect(mounted.result.current.disabled).toBe(false);
    expect(mounted.result.current.seed).toBeUndefined();
  } finally {
    await act(async () => {
      create.resolve();
      metadataRead.resolve([h.meta()]);
    });
  }
});

it("locks immediately on retry and pending transitions, and surfaces failed readback", async () => {
  const h = setup();
  const mounted = renderHook(
    ({ current }) => useSoloForkLock(h.session, current),
    {
      initialProps: { current: channel },
    },
  );
  await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
  const held = deferred<readonly EventData[]>();
  h.read.mockReturnValueOnce(held.promise);
  act(() => mounted.result.current.retry());
  try {
    expect(mounted.result.current.disabled).toBe(true);
    expect(mounted.result.current.seed).toBeUndefined();
    await waitFor(() =>
      expect(
        h.read.mock.calls.filter(
          ([filters]) =>
            filters[0]?.kinds?.includes(39000) &&
            filters[0]?.["#d"]?.[0] === id,
        ),
      ).toHaveLength(2),
    );
    await act(async () => held.resolve([]));
    await waitFor(() =>
      expect(mounted.result.current.reason).toContain("signed metadata"),
    );
    expect(mounted.result.current.disabled).toBe(true);
    expect(mounted.result.current.pending).toBe(false);
    act(() => mounted.result.current.retry());
    await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
    mounted.rerender({ current: { ...channel, pending: true } });
    expect(mounted.result.current.disabled).toBe(true);
    await waitFor(() => expect(h.starting).toHaveBeenCalledTimes(4));
    mounted.rerender({ current: channel });
    expect(mounted.result.current.disabled).toBe(true);
    await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
  } finally {
    await act(async () => held.resolve([]));
  }
});

it("fences late results across channel and session switches and unmount", async () => {
  const h = setup(),
    replacement = setup();
  const old = deferred<readonly EventData[]>();
  h.read.mockReturnValueOnce(old.promise);
  const mounted = renderHook(
    ({ session, current }) => useSoloForkLock(session, current),
    {
      initialProps: { session: h.session, current: channel },
    },
  );
  await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
  const next = deferred<readonly EventData[]>();
  h.read.mockReturnValueOnce(next.promise);
  mounted.rerender({
    session: h.session,
    current: { ...channel, id: "33333333-3333-4333-8333-333333333333" },
  });
  try {
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve([h.meta()]));
    expect(mounted.result.current.disabled).toBe(true);
    await act(async () =>
      next.resolve([
        h.meta("33333333-3333-4333-8333-333333333333", [
          ["forked_from", other, h.cutoff.id],
        ]),
      ]),
    );
    await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
    const last = deferred<readonly EventData[]>();
    replacement.read.mockReturnValueOnce(last.promise);
    mounted.rerender({ session: replacement.session, current: channel });
    expect(mounted.result.current.disabled).toBe(true);
    await waitFor(() => expect(replacement.read).toHaveBeenCalledOnce());
    const options = replacement.read.mock.calls[0]?.[1] as {
      signal: AbortSignal;
    };
    mounted.unmount();
    expect(options.signal.aborted).toBe(true);
    await act(async () => last.resolve([replacement.meta()]));
  } finally {
    await act(async () => {
      old.resolve([]);
      next.resolve([]);
    });
  }
});

it("keeps a signed fork locked when required parent access fails, then exposes the shared seed on retry", async () => {
  const h = setup();
  const cutoff = eventDto(message(keypair(), other, "Inherited", 10));
  const fork = h.meta(id, [["forked_from", other, cutoff.id]]);
  let denied = true;
  h.read.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(39000))
      return [filter["#d"]?.[0] === id ? fork : h.meta(other)];
    if (filter?.ids) {
      if (denied) throw new Error("Source access revoked");
      return [cutoff];
    }
    const target = filter?.["#h"]?.[0] ?? id;
    const cursor = filter?.before_id
      ? `${filter.until}:${filter.before_id}`
      : "head";
    return [
      ...(target === other ? [cutoff] : []),
      eventDto(
        bounds(h.relay, target, cursor, { has_more: false, next_cursor: null }),
      ),
    ];
  });
  const mounted = renderHook(() => useSoloForkLock(h.session, channel));
  await waitFor(() =>
    expect(mounted.result.current.reason).toBe("Source access revoked"),
  );
  expect(mounted.result.current.disabled).toBe(true);
  denied = false;
  act(() => mounted.result.current.retry());
  await waitFor(() => expect(mounted.result.current.disabled).toBe(false));
  expect(
    mounted.result.current.seed?.inherited.map((row) => row.content),
  ).toEqual(["Inherited"]);
});

it("does not lock or read ordinary Solo chats, including pending and unresolved metadata", () => {
  const h = setup();
  const mounted = renderHook(
    ({ current }) => useSoloForkLock(h.session, current),
    {
      initialProps: {
        current: {
          id,
          name: "Ordinary",
          channelType: "solo",
        } as ChannelSummary,
      },
    },
  );
  expect(mounted.result.current.disabled).toBe(false);
  mounted.rerender({
    current: { id, name: "Pending", pending: true, metadataPending: true },
  });
  expect(mounted.result.current.disabled).toBe(false);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.starting).not.toHaveBeenCalled();
});

it("fork tag present, no admission proof stays locked; absent signed ancestry cannot unlock either", async () => {
  const h = setup();
  h.read.mockResolvedValueOnce([{ ...h.meta() }]);
  const mounted = renderHook(() => useSoloForkLock(h.session, channel));
  await waitFor(() => expect(mounted.result.current.pending).toBe(false));
  expect(mounted.result.current.disabled).toBe(true);
  expect(mounted.result.current.reason).toContain("signature verified");
  h.read.mockResolvedValueOnce([h.meta(id, [])]);
  act(() => mounted.result.current.retry());
  await waitFor(() => expect(mounted.result.current.pending).toBe(false));
  expect(mounted.result.current.disabled).toBe(true);
  expect(mounted.result.current.reason).toContain("signed ancestry");
});
