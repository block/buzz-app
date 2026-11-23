// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import { MessageRow } from "./MessageRow";
import { activityPresentation } from "./activity-presentation";

stubAvatarBrowserApis();
afterEach(cleanup);
const agents = new Set(["builder", "reviewer"]);
const profiles = new Map<string, Profile>([
  ["builder", { name: "Builder", isAgent: true }],
  ["reviewer", { name: "Reviewer", isAgent: true }],
]);
const row: ChannelMessage = {
  id: "step",
  channelId: "channel",
  authorId: "builder",
  createdAt: 100,
  audience: "agents",
  content: "Please inspect [the source](https://example.org/source).",
  mentions: ["reviewer"],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
const props = {
  profile: profiles.get("builder"),
  participantProfiles: profiles,
  agentPubkeys: agents,
  media: () => undefined,
  onOpenLink: () => false,
  day: false,
  retry: undefined,
};

it.each([
  ["no recipient", { mentions: [] }],
  ["person recipient", { mentions: ["person"] }],
  ["mixed recipients", { mentions: ["reviewer", "person"] }],
  ["unknown author", { authorId: "unknown" }],
  ["edited body", { edited: true }],
  [
    "attachment",
    { attachments: [{ kind: "file", url: "https://example.org/result.txt" }] },
  ],
  ["failure", { notice: "execution-failure" }],
  ["diff", { diff: { truncated: false } }],
  ["plugin request", { pluginRequest: { id: "request" } }],
  ["forward", { relayedFrom: { agent: "builder", verified: true } }],
  ["workflow", { workflowOwnerId: "owner" }],
  ["failed delivery", { delivery: "failed" }],
  ["pending delivery", { delivery: "sending" }],
  ["uncertain delivery", { delivery: "unknown" }],
] satisfies [string, Partial<ChannelMessage>][])(
  "retains the preview for %s",
  (_name, patch) => {
    render(<MessageRow {...props} row={{ ...row, ...patch }} />);
    expect(screen.queryByText(/Agent coordination/)).toBeNull();
  },
);

it("requires positive recipient hints and leaves public results visible", () => {
  const view = render(
    <MessageRow {...props} row={row} agentPubkeys={new Set(["builder"])} />,
  );
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
  view.rerender(<MessageRow {...props} row={row} />);
  expect(screen.getByText(/Agent coordination/)).toBeVisible();
  const { audience: _audience, ...publicResult } = row;
  view.rerender(<MessageRow {...props} row={publicResult} />);
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
  expect(screen.getByRole("link", { name: "the source" })).toBeVisible();
});

function Group({
  rows = [row],
  known = agents,
  working = false,
}: {
  rows?: ChannelMessage[];
  known?: ReadonlySet<string>;
  working?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const group = activityPresentation(rows, undefined, agents).groups[0];
  if (!group) throw new Error("Expected coordination run");
  return (
    <ActivityGroupPreview
      group={{ ...group, working }}
      profiles={profiles}
      agentPubkeys={known}
      media={props.media}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      renderHistory={(entry) => (
        <MessageRow
          {...props}
          row={entry}
          profile={profiles.get(entry.authorId)}
          recordedActivity={{
            container: "history",
            active: false,
            ownsLive: false,
            requestId: undefined,
          }}
        />
      )}
    />
  );
}

it.each(["timeline", "thread"] as const)(
  "discloses a standalone %s row without losing its author, source or keyboard focus",
  async (layout) => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <MessageRow
          {...props}
          row={row}
          layout={layout}
          recordedActivity={{
            container: "standalone",
            active: false,
            ownsLive: false,
            requestId: undefined,
          }}
        />
      </StrictMode>,
    );
    const toggle = screen.getByRole("button", {
      name: "Show activity history: Agent coordination · 1 message",
    });
    expect(toggle).toHaveTextContent("Agent coordination · 1 message");
    expect(screen.queryByText("Builder", { selector: "strong" })).toBeNull();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(
      screen.getAllByText("Builder", { selector: "strong" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "the source" })).toHaveAttribute(
      "href",
      "https://example.org/source",
    );
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  },
);

it("counts the whole group and keeps authors and sources available on expansion", async () => {
  const user = userEvent.setup();
  render(
    <Group
      rows={[
        row,
        {
          ...row,
          id: "reply",
          authorId: "reviewer",
          mentions: ["builder"],
          content: "Review complete",
          createdAt: 101,
        },
      ]}
    />,
  );
  const toggle = screen.getByRole("button", {
    name: "Show activity history: Agent coordination · 2 messages",
  });
  expect(screen.getByRole("img", { name: "Builder, Reviewer" })).toBeVisible();
  expect(screen.queryByText("Builder", { selector: "strong" })).toBeNull();
  await user.click(toggle);
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const details = document.querySelector("[data-activity-details]");
  expect(details).not.toBeNull();
  expect(
    within(details as HTMLElement).getByRole("button", {
      name: /Builder: Please inspect/,
    }),
  ).toBeVisible();
  expect(
    within(details as HTMLElement).getByRole("button", {
      name: "Reviewer: Review complete",
    }),
  ).toBeVisible();
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("fails closed for an earlier ambiguous row and responds to identity removal", () => {
  const second = {
    ...row,
    id: "next",
    createdAt: 101,
    content: "Latest update",
  };
  const view = render(<Group rows={[{ ...row, mentions: [] }, second]} />);
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
  expect(screen.getByRole("button", { name: /Latest update/ })).toBeVisible();
  view.rerender(<Group rows={[row, second]} />);
  expect(screen.getByText("Agent coordination · 2 messages")).toBeVisible();
  view.rerender(<Group rows={[row, second]} known={new Set(["builder"])} />);
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
});

it("keeps an individual row content-bearing when its presentation reports an outcome", () => {
  render(
    <MessageRow
      {...props}
      row={row}
      recordedActivity={{
        container: "standalone",
        active: false,
        ownsLive: false,
        requestId: "request",
        hasOutcome: true,
      }}
    />,
  );
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
  expect(
    screen.getByRole("button", { name: /Builder: Please inspect/ }),
  ).toBeVisible();
});

it("keeps active work content-bearing instead of replacing its working cue", () => {
  render(<Group working />);
  expect(screen.queryByText(/Agent coordination/)).toBeNull();
  expect(screen.getByRole("button", { name: /still working/ })).toBeVisible();
});
