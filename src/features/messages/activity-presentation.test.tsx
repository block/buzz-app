// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import {
  activityPresentation,
  useStableRowActivity,
} from "./activity-presentation";
import { useLiveConversationAgents } from "./TypingIndicator";
import { agent, entry, fixture, root } from "./typing-indicator-testing";

afterEach(cleanup);

it("keeps row activity props identical while each projection's values are equal", () => {
  const { result } = renderHook(() => useStableRowActivity());
  const bubble = { container: "bubble" } as const;
  const first = result.current.activity("row", bubble, "history");
  expect(first).toEqual({ container: "history" });
  expect(result.current.activity("row", { ...bubble }, "history")).toBe(first);
  const changed = result.current.activity("row", bubble);
  expect(changed).not.toBe(first);
  expect(changed).toEqual(bubble);
  expect(result.current.activity("row", undefined, "history")).toBeUndefined();

  const agents = result.current.agents("row", [agent]);
  expect(result.current.agents("row", [agent])).toBe(agents);
  expect(result.current.agents("row", [agent, "other"])).not.toBe(agents);
});

it("re-renders a live-agents host only when its working agents change", () => {
  const live = fixture();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useLiveConversationAgents(live.session, "channel", root);
  });
  expect(result.current).toEqual([]);
  const idle = renders;
  live.update([{ pubkey: agent, channelId: "elsewhere", threadRootId: root }]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(idle);
  live.update([entry()]);
  expect(result.current).toEqual([agent]);
});

it("maps each request to its agents' latest public replies", () => {
  const message = (
    id: string,
    authorId: string,
    extra: Partial<ChannelMessage> = {},
  ) =>
    ({
      id,
      channelId: "channel",
      authorId,
      createdAt: 1,
      content: id,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
      ...extra,
    }) as ChannelMessage;
  const human = "h".repeat(64);
  const { repliedAgents, replyRequests } = activityPresentation(
    [
      message("request", human),
      message("first", agent),
      message("update", agent, { audience: "agents" }),
      message("latest", agent),
      message("later", human),
    ],
    new Set([agent]),
  );
  expect(repliedAgents.get("request")).toEqual([agent]);
  expect(replyRequests.get("latest")).toBe("request");
  expect(replyRequests.has("first")).toBe(false);
  expect(replyRequests.has("update")).toBe(false);
  expect(repliedAgents.has("later")).toBe(false);
});
