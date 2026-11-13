// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { LiveListener } from "../../features/relay/incoming";
import type { ThreadSnapshot, ThreadView } from "../../features/relay/threads";
import { useLaneMessages } from "./use-lane-messages";

afterEach(cleanup);
function setup() {
  let listener: LiveListener | undefined;
  const calls: { root: string; finish(): void; view: ThreadView }[] = [];
  const session = {
    subscribeLive: (next: LiveListener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    thread: vi.fn((_channel: string, root: string) => {
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const snapshot: ThreadSnapshot = {
        status: "ready",
        root: undefined,
        error: undefined,
        canLoadMore: false,
        limited: false,
        replies: [
          {
            id: `${root}-last`,
            channelId: "channel",
            content: `Last reply in ${root}`,
            authorId: "author",
            createdAt: 2,
            mentions: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
            participants: [],
          },
        ],
      };
      const view: ThreadView = {
        refresh: () => pending,
        snapshot: () => snapshot,
        subscribe: () => () => {},
        dispose: vi.fn(),
        loadMore: async () => {},
        retarget: async () => "selected",
      };
      calls.push({ root, finish, view });
      return view;
    }),
  } as unknown as RelaySession;
  return {
    session,
    calls,
    emit: (root: string, channel = "channel") =>
      act(() =>
        listener?.({
          events: [
            {
              id: "new",
              kind: 9,
              content: "new reply",
              pubkey: "author",
              created_at: 3,
              tags: [
                ["h", channel],
                ["e", root, "", "reply"],
              ],
            } as import("../../features/relay/events").RelayEvent,
          ],
        }),
      ),
  };
}
it("bounds concurrent reads, shows newest replies, and disposes in-flight reads on leaving", async () => {
  const test = setup();
  const view = renderHook(() =>
    useLaneMessages(test.session, "channel", "a:b:c:d:e:f", 0),
  );
  expect(test.calls).toHaveLength(4);
  await act(async () => test.calls[0]?.finish());
  expect(view.result.current.a?.message?.content).toBe("Last reply in a");
  expect(test.calls[0]?.view.dispose).toHaveBeenCalledTimes(1);
  expect(test.calls).toHaveLength(5);
  view.unmount();
  for (const call of test.calls.slice(1))
    expect(call.view.dispose).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (const call of test.calls) call.finish();
  });
  expect(test.calls).toHaveLength(5); // The queued sixth lane never starts after teardown.
});
it("refreshes only the affected lane and ignores events in other channels", async () => {
  const test = setup();
  const view = renderHook(() =>
    useLaneMessages(test.session, "channel", "a:b", 0),
  );
  await act(async () => {
    for (const call of test.calls) call.finish();
  });
  test.emit("a", "elsewhere");
  expect(test.calls).toHaveLength(2);
  test.emit("a");
  expect(test.calls.map((call) => call.root)).toEqual(["a", "b", "a"]);
  await act(async () => test.calls[2]?.finish());
  await waitFor(() =>
    expect(view.result.current.a?.message?.id).toBe("a-last"),
  );
});
