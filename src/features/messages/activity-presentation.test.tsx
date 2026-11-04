// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import {
  useStableRowActivity,
  type ActivityRowPresentation,
} from "./activity-presentation";
import { useActivityIndicator } from "./use-activity-indicator";
import { agent, entry, fixture, root } from "./typing-indicator-testing";

afterEach(cleanup);

it("keeps row activity props identical while each projection's values are equal", () => {
  const { result } = renderHook(() => useStableRowActivity());
  const row = (active: boolean): ActivityRowPresentation => ({
    requestId: root,
    active,
    ownsLive: true,
    container: "bubble",
  });
  const first = result.current.activity("row", row(false), "history");
  expect(first).toEqual({ ...row(false), container: "history" });
  expect(result.current.activity("row", row(false), "history")).toBe(first);
  const changed = result.current.activity("row", row(true), "history");
  expect(changed).not.toBe(first);
  expect(changed?.active).toBe(true);
  expect(result.current.activity("row", row(true))).toEqual(row(true));
  expect(result.current.activity("row", undefined, "history")).toBeUndefined();

  const agents = result.current.agents("row", [agent]);
  expect(result.current.agents("row", [agent])).toBe(agents);
  expect(result.current.agents("row", [agent, "other"])).not.toBe(agents);
});

it("re-renders on typing and activity only for the row that owns the live signal", () => {
  const live = fixture();
  const row = {
    id: "update",
    channelId: "channel",
    threadRootId: root,
    authorId: agent,
  } as ChannelMessage;
  let renders = 0;
  const { rerender } = renderHook(
    ({ eligible }: { eligible: boolean }) => {
      renders++;
      return useActivityIndicator(live.session, row, eligible);
    },
    { initialProps: { eligible: false } },
  );
  const quiet = renders;
  live.update([entry()]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(quiet);

  rerender({ eligible: true });
  const owner = renders;
  live.update([entry()]);
  expect(renders).toBeGreaterThan(owner);
});
