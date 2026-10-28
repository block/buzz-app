// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createAgentActivity } from "../agents/activity";
import { createLocalAgentActivity } from "../agents/local-activity";
import { createRelaySession } from "../relay/session";
import { keypair } from "../relay/testing";
import type { ChannelMessage } from "../relay/contracts";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import {
  activityPresentation,
  useActivityPresentation,
} from "./activity-presentation";
import { MessageRow } from "./MessageRow";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});
const step: ChannelMessage = {
  id: "step",
  channelId: "channel",
  threadRootId: "request",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: "Checking the layout",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
function fixture() {
  const local = createLocalAgentActivity();
  const activity = createAgentActivity(
    true,
    () => {},
    () => true,
    undefined,
    undefined,
    { source: local.reader, scope: "test" },
  );
  const release = activity.queries.activate();
  return {
    local,
    activity: activity.queries,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
it("keeps a closed sequence completed when another request starts in the same thread", () => {
  const f = fixture();
  try {
    const { audience: _audience, ...publicStep } = step;
    function Preview() {
      const presentation = useActivityPresentation(
        [
          { ...step, id: "first" },
          step,
          {
            ...publicStep,
            id: "reply",
            content: "Result",
            createdAt: 101,
          },
        ],
        f.activity,
        new Set(["agent"]),
        "request",
      );
      const group = presentation.groups[0];
      if (!group) throw new Error("Missing activity group");
      return (
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={false}
          onToggle={() => {}}
        />
      );
    }
    render(<Preview />);
    expect(screen.getByText("2 completed steps")).toBeVisible();
    act(() => {
      f.local
        .begin({
          scope: "test",
          agent: "agent",
          channelId: "channel",
          messageId: "next-request",
          threadRootId: "request",
        })
        .started();
    });
    expect(screen.getByText("2 completed steps")).toBeVisible();
    expect(screen.getByText("2 completed steps")).not.toHaveAttribute(
      "data-active",
    );
  } finally {
    f.dispose();
  }
});
it("shimmers a standalone working step and stops when that request finishes", () => {
  const f = fixture();
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  try {
    const work = f.local.begin({
      scope: "test",
      agent: "agent",
      channelId: "channel",
      messageId: "request",
      threadRootId: "request",
    });
    work.started();
    function Preview() {
      const presentation = useActivityPresentation(
        [step],
        f.activity,
        new Set(["agent"]),
        step.threadRootId,
      );
      return (
        <MessageRow
          row={step}
          recordedActivity={presentation.byRow.get(step.id)}
          session={{ ...owner.session, agentActivity: f.activity }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    }
    render(<Preview />);
    expect(screen.getByText(step.content)).toHaveAttribute(
      "data-active",
      "true",
    );
    act(() => work.finish({ ok: true }));
    expect(screen.getByText(step.content)).not.toHaveAttribute("data-active");
  } finally {
    owner.dispose();
    f.dispose();
  }
});

it("moves the visible team avatars into history and returns them to their clustered positions", async () => {
  const history = [step, { ...step, id: "helper-step", authorId: "helper" }];
  const presentation = activityPresentation(
    history,
    undefined,
    new Set(["agent", "helper"]),
  );
  const group = presentation.groups[0];
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animations: { node: HTMLElement; frames: Keyframe[] }[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[]) {
      animations.push({ node: this, frames });
      return { finished, cancel: () => {} };
    },
  });
  // jsdom has no layout. Supply boxes only for the visible cluster and the
  // actual history rows, excluding hidden duplicate artwork.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const identity = this.closest('[role="img"]');
      if (!this.dataset.avatarMotionKey || this.closest("[inert]"))
        return new DOMRect();
      if (identity) return new DOMRect(10, 20, 25, 25);
      return this.closest('[data-audience="agents"]')
        ? new DOMRect(50, this.title === "helper" ? 120 : 70, 40, 40)
        : new DOMRect();
    },
  );
  function Preview() {
    const [expanded, setExpanded] = useState(false);
    if (!group) throw new Error("Missing activity group");
    return (
      <div data-activity-history-scope="">
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
        {expanded &&
          history.map((row) => {
            const activity = presentation.byRow.get(row.id);
            if (!activity) throw new Error("Missing history presentation");
            return (
              <MessageRow
                key={row.id}
                row={row}
                recordedActivity={{ ...activity, container: "history" }}
                profile={undefined}
                media={() => undefined}
                onOpenLink={() => false}
                day={false}
                retry={undefined}
              />
            );
          })}
      </div>
    );
  }
  try {
    render(<Preview />);
    const team = screen.getByRole("img", { name: "agent, helper" });
    const restingTransform = "matrix(0.6, 0, 0, 0.6, 12, 12)";
    for (const avatar of team.querySelectorAll<HTMLElement>("[title]")) {
      avatar.style.transform = restingTransform;
    }
    fireEvent.click(
      screen.getByRole("button", { name: /Show activity history/ }),
      {
        detail: 1,
      },
    );
    const expanded = animations.filter(
      ({ node }) => node.dataset.avatarMotionKey,
    );
    expect(expanded).toHaveLength(2);
    expect(
      expanded.every(
        ({ node }) =>
          node.closest('[data-audience="agents"]') &&
          !node.closest("[data-agent-response-preview]"),
      ),
    ).toBe(true);
    expect(
      expanded.every(({ frames }) =>
        frames[0]?.transform?.toString().includes("translate("),
      ),
    ).toBe(true);
    animations.length = 0;
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse activity history/ }),
      {
        detail: 1,
      },
    );
    const collapsed = animations.filter(
      ({ node }) => node.dataset.avatarMotionKey,
    );
    expect(collapsed).toHaveLength(2);
    expect(collapsed.every(({ node }) => team.contains(node))).toBe(true);
    expect(collapsed.map(({ frames }) => frames.at(-1)?.transform)).toEqual([
      restingTransform,
      restingTransform,
    ]);
  } finally {
    await act(async () => finish());
  }
});

it("keeps the primary avatar on the activity bubble without repeating an anchored byline", () => {
  const history = [{ ...step, id: "one" }, step];
  const renderGroup = (rows: ChannelMessage[]) => {
    const group = activityPresentation(rows, undefined, new Set(["agent"]))
      .groups[0];
    if (!group) throw new Error("Missing group");
    return (
      <ActivityGroupPreview
        group={group}
        profiles={new Map([["agent", { name: "Studio assistant" }]])}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />
    );
  };
  const view = render(renderGroup(history));
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
  const { audience: _, ...reply } = step;
  view.rerender(renderGroup([{ ...reply, id: "reply" }, ...history]));
  expect(screen.queryByText("Studio assistant", { exact: true })).toBeNull();
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...step, id: "one" },
      { ...step, authorId: "helper" },
    ]),
  );
  expect(
    screen.getByRole("img", { name: "Studio assistant, helper" }),
  ).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...reply, id: "user", authorId: "human" },
      ...history,
    ]),
  );
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
});
