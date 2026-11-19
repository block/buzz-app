// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { chatLinksModel } from "../../../tests/fixtures/github-chat-links-model";
import { ConversationChannel } from "../../features/conversation/Conversation";
import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import {
  LinkPreviewContext,
  type LinkPreview,
} from "../../features/conversation/LinkLabelContext";
import { MessageLink } from "../../features/conversation/MessageLink";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChatPullLink, ChatPullPreview } from "./ChatPullLink";
import { setOpenGitHubLinksInBuzz } from "./link-preference";

const pull = "https://github.com/example-org/widgets/pull/42";
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  localStorage.clear();
});
function model() {
  const value = chatLinksModel();
  disposers.push(value.dispose);
  return value;
}

function Action({ value }: { value: ReturnType<typeof model> }) {
  const [preview, offer] = useState<LinkPreview>();
  return (
    <>
      <ChatPullPreview
        {...value}
        channelId={value.channel.id}
        url={pull}
        offer={offer}
      />
      <div>{preview?.render(() => false)}</div>
    </>
  );
}

it("links and unlinks the same artifact and cache that the Solo sidebar uses, with browser opening selected", async () => {
  setOpenGitHubLinksInBuzz(false);
  const value = model();
  render(<Action value={value} />);
  await userEvent.click(screen.getByRole("button", { name: "Link to chat" }));
  expect(
    await screen.findByRole("button", { name: "Unlink from chat" }),
  ).toBeEnabled();
  expect(JSON.parse(value.writes[0]?.content ?? "null")).toEqual({
    version: 1,
    url: pull,
  });
  expect(value.pulls.get(value.channel.id)?.url).toBe(pull);
  await userEvent.click(
    screen.getByRole("button", { name: "Unlink from chat" }),
  );
  expect(
    await screen.findByRole("button", { name: "Link to chat" }),
  ).toBeEnabled();
  expect(JSON.parse(value.writes[1]?.content ?? "null")).toEqual({
    version: 1,
    url: null,
  });
  expect(value.pulls.get(value.channel.id)).toBeUndefined();
});

it("keeps the link unchanged on a failed save and lets the person retry", async () => {
  const value = model();
  value.setPublish(async () => {
    throw new Error("Save refused");
  });
  render(<Action value={value} />);
  await userEvent.click(screen.getByRole("button", { name: "Link to chat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save refused");
  expect(value.pulls.get(value.channel.id)).toBeUndefined();
  expect(value.writes).toHaveLength(0);
  value.setPublish(async () => {});
  await userEvent.click(screen.getByRole("button", { name: "Link to chat" }));
  await screen.findByRole("button", { name: "Unlink from chat" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("holds the action while saving, and still updates the sidebar if its link leaves the view", async () => {
  const value = model();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  value.setPublish(() => gate);
  const view = render(<Action value={value} />);
  try {
    const button = screen.getByRole("button", { name: "Link to chat" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(button);
    view.unmount();
    complete();
    await waitFor(() => expect(value.writes).toHaveLength(1));
    expect(value.pulls.get(value.channel.id)?.url).toBe(pull);
  } finally {
    complete();
  }
});

it("revokes writes after connection, community, ownership, archive or presentation changes", () => {
  const value = model();
  const view = render(<Action value={value} />);
  const disabled = () =>
    expect(screen.getByRole("button", { name: "Link to chat" })).toBeDisabled();
  act(() => value.setConnection({ cached: true }));
  disabled();
  act(() =>
    value.setConnection({ cached: undefined, scope: "another-community" }),
  );
  disabled();
  act(() =>
    value.setConnection({ scope: value.scope, status: "disconnected" }),
  );
  disabled();
  act(() => {
    value.setConnection({ status: "ready" });
    value.setChannel({ creator: "b".repeat(64) });
  });
  disabled();
  act(() => value.setChannel({ creator: value.viewer, archived: true }));
  disabled();
  act(() => value.setChannel({ archived: undefined, readOnly: true }));
  disabled();
  act(() => value.setChannel({ readOnly: undefined }));
  expect(screen.getByRole("button", { name: "Link to chat" })).toBeEnabled();
  view.rerender(
    <ConversationPresentation value={false}>
      <Action value={value} />
    </ConversationPresentation>,
  );
  disabled();
  expect(value.writes).toHaveLength(0);
});

function Message({
  value,
  url = pull,
  interactive = true,
}: {
  value: ReturnType<typeof model>;
  url?: string;
  interactive?: boolean;
}) {
  const entries = [
    {
      id: "pull",
      key: "buzz.github/pull",
      pluginId: "buzz.github",
      revision: "test",
      title: "GitHub",
      matches: () => true,
      component: ({ url }: { url: string }) => (
        <ChatPullLink {...value} url={url} />
      ),
    },
  ];
  return (
    <ToastProvider>
      <ConversationChannel
        session={value.session}
        scope={value.scope}
        channel={value.channel}
        extensions={{
          tools: { snapshot: () => [], subscribe: () => () => {} },
          inline: { snapshot: () => [], subscribe: () => () => {} },
        }}
        active={false}
        interactions={{
          onOpenLink: () => false,
          canOpenLink: () => false,
          onOpenMediaReview: () => {},
        }}
      >
        <MessageLink
          session={value.session}
          scope={value.scope}
          url={url}
          interactive={interactive}
          label="Review changes"
          registry={{ snapshot: () => entries, subscribe: () => () => {} }}
          onOpenLink={() => false}
        />
      </ConversationChannel>
    </ToastProvider>
  );
}

it("offers an action outside the host anchor and canonicalizes a PR subtarget", async () => {
  const value = model();
  setOpenGitHubLinksInBuzz(false);
  const view = render(
    <Message value={value} url={`${pull}/files#diff-example`} />,
  );
  const link = screen.getByRole("link", { name: "Review changes" });
  expect(link).toHaveAttribute("href", `${pull}/files#diff-example`);
  expect(link).not.toContainElement(screen.queryByRole("button"));
  act(() => link.focus());
  // jsdom has no anchor geometry; real hover/focus reachability is a browser check.
  const action = (await screen.findByText("Link to chat")).closest("button");
  if (!action) throw new Error("Expected a linking button");
  expect(link).not.toContainElement(action);
  expect(
    screen.getByRole("dialog", { name: "Pull request actions", hidden: true }),
  ).toBeInTheDocument();
  fireEvent.click(action);
  await screen.findByText("Unlink from chat");
  expect(JSON.parse(value.writes[0]?.content ?? "null").url).toBe(pull);
  view.unmount();
});

it.each([
  `${pull.replace("/pull/", "/issues/")}`,
  "https://github.com/example-org/widgets",
])("does not offer PR linking for %s", async (url) => {
  const value = model();
  render(<Message value={value} url={url} />);
  act(() => screen.getByRole("link", { name: "Review changes" }).focus());
  expect(screen.queryByText("Link to chat")).not.toBeInTheDocument();
  expect(value.writes).toHaveLength(0);
});

it.each([
  { channelType: "stream" as const },
  { channelType: "forum" as const },
  { channelType: "dm" as const },
  { creator: "b".repeat(64) },
  { archived: true as const },
  { readOnly: true as const },
])("does not offer linking in an ineligible conversation: %j", (change) => {
  const value = model();
  value.setChannel(change);
  render(<Message value={value} />);
  act(() => screen.getByRole("link", { name: "Review changes" }).focus());
  expect(screen.queryByText("Link to chat")).not.toBeInTheDocument();
  expect(value.writes).toHaveLength(0);
});

it("renders GitHub links outside a conversation without chat actions", () => {
  const value = model();
  const offered: (LinkPreview | undefined)[] = [];
  render(
    <LinkPreviewContext value={(preview) => offered.push(preview)}>
      <ChatPullLink {...value} url={pull} />
    </LinkPreviewContext>,
  );
  expect(offered).toEqual([]);
  expect(screen.queryByText("Link to chat")).not.toBeInTheDocument();
  expect(value.writes).toHaveLength(0);
});

it("does not offer a chat action for a noninteractive link", () => {
  const value = model();
  render(<Message value={value} interactive={false} />);
  expect(screen.queryByText("Link to chat")).not.toBeInTheDocument();
  expect(value.writes).toHaveLength(0);
});
