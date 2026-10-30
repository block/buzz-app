import { expect, it } from "vitest";
import {
  activityDisplayRows,
  activityPresentation,
} from "./activity-presentation";
import { activityRuns } from "./activity-groups";
import type { ChannelMessage } from "../relay/contracts";

const activity = (
  id: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  channelId: "solo",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: id,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
  ...patch,
});
const run = (prefix: string, count = 6) =>
  Array.from({ length: count }, (_, index) => activity(`${prefix}${index}`));

it("retires superseded tool updates while the steered request keeps working", () => {
  const { audience: _audience, ...request } = activity("request", {
    authorId: "human",
  });
  const steer = { ...request, id: "steer" };
  const oldStep = activity("old-step", { replyParentId: request.id });
  const newStep = activity("new-step", { replyParentId: steer.id });
  const rows = [request, oldStep, steer, newStep];
  const presentation = activityPresentation(
    rows,
    {
      status: "listening",
      typing: [],
      records: [],
      turns: [],
      trimmed: 0,
      local: [
        {
          scope: "test",
          agent: "agent",
          channelId: "solo",
          threadRootId: "request",
          messageId: "request",
          startedAt: 1,
          state: "superseded",
        },
        {
          scope: "test",
          agent: "agent",
          channelId: "solo",
          threadRootId: "request",
          messageId: "steer",
          startedAt: 2,
          state: "working",
        },
      ],
    },
    new Set(["agent"]),
  );
  expect(activityDisplayRows(rows, presentation.groups)).toEqual([
    request,
    steer,
    newStep,
  ]);
  expect(presentation.byRow.get(newStep.id)?.active).toBe(true);
});

it("folds consecutive activity into one preview and includes different agents in a run", () => {
  const single = run("a", 1);
  expect(activityRuns(single)).toEqual([single]);
  const rows = run("a");
  rows[2] = activity("other-agent", { authorId: "other" });
  expect(activityRuns(rows)).toEqual([rows]);
});

it.each(["human", "agent", "membership"])(
  "keeps ordinary messages and membership notices outside groups: %s",
  (kind) => {
    const before = run("before"),
      after = run("after");
    const { audience: _audience, ...ordinary } = activity("separator");
    const separator =
      kind === "membership"
        ? {
            ...ordinary,
            membership: {
              type: "member_joined" as const,
              actor: "human",
              target: "human",
            },
          }
        : { ...ordinary, authorId: kind };
    expect(activityRuns([...before, separator, ...after])).toEqual([
      before,
      after,
    ]);
  },
);

it("splits groups across local days and channels", () => {
  const today = run("today");
  const tomorrow = run("tomorrow").map((row) => ({
    ...row,
    createdAt: 100 + 86400,
  }));
  const elsewhere = run("elsewhere").map((row) => ({
    ...row,
    channelId: "other",
  }));
  expect(activityRuns([...today, ...tomorrow, ...elsewhere])).toEqual([
    today,
    tomorrow,
    elsewhere,
  ]);
});

it.each([1, 2])(
  "hides %i completed steps while keeping the reply and unfinished work in place",
  (count) => {
    const history = run("step", count);
    const { audience: _, ...reply } = activity("reply");
    const rows = [...history, reply];
    const completed = activityPresentation(rows, undefined, new Set(["agent"]));
    expect(
      activityDisplayRows(rows, completed.groups).map((row) => row.id),
    ).toEqual(["reply"]);
    const otherReply = { ...reply, authorId: "human" };
    const pending = [...history, otherReply];
    expect(
      activityDisplayRows(
        pending,
        activityPresentation(pending, undefined, new Set(["agent"])).groups,
      ),
    ).toEqual(pending);
  },
);

it("hands unparented thread replies to the latest request without overriding explicit reply links", () => {
  const { audience: _requestAudience, ...request } = activity("request", {
    authorId: "human",
    threadRootId: "root",
  });
  const { audience: _replyAudience, ...reply } = activity("reply", {
    agentEnvelope: true,
    threadRootId: "root",
  });
  const projected = (patch: Partial<ChannelMessage>) =>
    activityPresentation(
      [request, { ...reply, ...patch }],
      undefined,
      new Set(["agent"]),
      "root",
    ).representedAgents;
  expect(projected({}).get("request")).toEqual(["agent"]);
  expect(projected({}).get("root")).toBeUndefined();
  expect(projected({ replyParentId: "root" }).get("root")).toEqual(["agent"]);
  expect(projected({ replyParentId: "root" }).get("request")).toBeUndefined();
});
