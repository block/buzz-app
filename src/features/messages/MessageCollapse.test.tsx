// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { forgetCollapsedMessages } from "./collapsed-messages";
import { MessageRow } from "./MessageRow";

const scope = `https://one.example:${"a".repeat(64)}`;
const agent = "ab".repeat(32);
const row: ChannelMessage = {
  id: "report",
  channelId: "channel",
  authorId: agent,
  content: "**Ran** the whole suite.\n\nEverything passed except one flake.",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const session = {
  viewer: "viewer",
  presence: {
    subscribe: () => () => {},
    status: () => "unknown",
    limited: () => false,
  },
  unread: {
    subscribe: () => () => {},
    subscribeSync: () => () => {},
    snapshot: () => undefined,
    following: () => false,
  },
  messages: { report: undefined },
  channels: {
    subscribeList: () => () => {},
    list: () => ({ channels: [], status: "ready" }),
  },
} as unknown as RelaySession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetCollapsedMessages(scope);
  localStorage.clear();
});

function show(
  message: ChannelMessage,
  options: { agent?: boolean; collapsible?: boolean } = {},
) {
  const keepPlace = vi.fn();
  const view = (shown: ChannelMessage) => (
    <ToastProvider>
      <ConversationPresentation value={true}>
        <MessageRow
          row={shown}
          session={session}
          scope={scope}
          profile={undefined}
          agentPubkeys={new Set(options.agent === false ? [] : [agent])}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          onCollapseToggle={
            options.collapsible === false ? undefined : keepPlace
          }
        />
      </ConversationPresentation>
    </ToastProvider>
  );
  const result = render(view(message));
  return {
    keepPlace,
    rerender: (next: ChannelMessage) => result.rerender(view(next)),
  };
}
// The rendered body; the collapsed line has the same words, unformatted.
const body = () => screen.queryByText("Ran", { selector: "strong" });
const line = () =>
  screen.getByRole("button", { name: /, collapsed message: / });

it("collapses an agent message to its opening line and expands it again", async () => {
  const user = userEvent.setup();
  const { keepPlace } = show(row);
  const toggle = screen.getByRole("button", { name: "Collapse message" });
  // Its label carries the state; aria-expanded would also draw it pressed.
  expect(toggle).not.toHaveAttribute("aria-expanded");
  await user.click(toggle);
  expect(keepPlace).toHaveBeenCalledWith("report");
  expect(body()).toBeNull();
  expect(line()).toHaveAccessibleName(
    `${agent.slice(0, 10)}, collapsed message: Ran the whole suite. Everything passed except one flake.. Expand message`,
  );
  expect(line()).toHaveAttribute("aria-expanded", "false");
  // Plain text, without the Markdown.
  expect(line()).toHaveTextContent(
    /^Ran the whole suite\. Everything passed except one flake\.$/,
  );
  // The header stays; the toolbar toggle now expands.
  expect(screen.getByText(agent.slice(0, 10))).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Expand message" }),
  ).not.toHaveAttribute("aria-expanded");
  // From the keyboard, on the line itself.
  line().focus();
  await user.keyboard("{Enter}");
  expect(body()).toBeInTheDocument();
  expect(localStorage.getItem(`buzz.collapsed-messages.v1:${scope}`)).toBe(
    "[]",
  );
});

it("collapses from the overflow menu and survives a remount", async () => {
  const user = userEvent.setup();
  show(row);
  fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Collapse message" }),
  );
  await waitFor(() => expect(body()).toBeNull());
  cleanup();
  show(row);
  expect(body()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Expand message" }),
  ).toBeInTheDocument();
});

it("shows an edit's text in place while collapsed", async () => {
  const user = userEvent.setup();
  const { rerender } = show(row);
  await user.click(screen.getByRole("button", { name: "Collapse message" }));
  rerender({ ...row, content: "Now **all** green." });
  expect(line()).toHaveTextContent(/^Now all green\.$/);
  expect(screen.queryByText("all", { selector: "strong" })).toBeNull();
});

it("offers collapse only for agent messages where the host supports it", () => {
  localStorage.setItem(
    `buzz.collapsed-messages.v1:${scope}`,
    JSON.stringify([["report", 1]]),
  );
  show(row, { agent: false });
  // A stored choice for a message no longer seen as an agent's is ignored.
  expect(body()).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Collapse message|Expand message/ }),
  ).toBeNull();
  cleanup();
  show(row, { collapsible: false });
  expect(body()).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Collapse message|Expand message/ }),
  ).toBeNull();
});

it("says so and stays expanded when the choice cannot be saved", async () => {
  const user = userEvent.setup();
  show(row);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  await user.click(screen.getByRole("button", { name: "Collapse message" }));
  expect(body()).toBeInTheDocument();
  expect(
    await screen.findByText("Couldn't save. The message stays expanded."),
  ).toBeInTheDocument();
});
