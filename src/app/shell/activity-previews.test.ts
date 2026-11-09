// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { useLatestMessages } from "./activity-previews";

const event = (
  id: string,
  channel: string,
  createdAt: number,
  extra: { kind?: number; tags?: string[][] } = {},
) => ({
  id,
  kind: extra.kind ?? 9,
  pubkey: "a".repeat(64),
  created_at: createdAt,
  content: id,
  tags: [["h", channel], ...(extra.tags ?? [])],
});

test("asks each channel for its newest top-level message, one row each", async () => {
  const snapshotRead = vi.fn(async (_filters: unknown) => [
    event("busy-top", "busy", 100),
    // The window's bounds event and a stray reply are never the preview.
    event("bounds", "busy", 300, { kind: 39006 }),
    event("busy-reply", "busy", 200, {
      tags: [["e", "f".repeat(64), "", "reply"]],
    }),
  ]);
  const session = { snapshotRead } as unknown as RelaySession;
  const { result } = renderHook(() =>
    useLatestMessages(session, ["busy", "empty"]),
  );
  await waitFor(() => expect(result.current.get("empty")).toBeNull());
  expect(snapshotRead).toHaveBeenCalledTimes(1);
  expect(snapshotRead.mock.calls[0]?.[0]).toEqual([
    { kinds: [9], "#h": ["busy"], limit: 1, top_level: true },
    { kinds: [9], "#h": ["empty"], limit: 1, top_level: true },
  ]);
  expect(result.current.get("busy")?.id).toBe("busy-top");
});
