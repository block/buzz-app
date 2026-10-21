// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityLanding } from "./CommunityLanding";
import type { Communities } from "./service";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const communities = {
  snapshot: () => ({
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "", about: "" },
    memberships: [],
    selected: null,
  }),
} as unknown as Communities;

function landing({
  hosted = false,
  invite = undefined as
    | { community: string; code: string; requestId: number }
    | undefined,
} = {}) {
  const props = {
    onInviteClose: vi.fn(),
    onJoined: vi.fn(),
    onCreate: vi.fn(),
    onSkip: vi.fn(),
  };
  render(
    <CommunityLanding
      communities={communities}
      invite={invite}
      settingsCards={{ subscribe: () => () => {}, has: () => hosted }}
      {...props}
    />,
  );
  return props;
}

it("opens the join steps from a pasted invite page link", async () => {
  const user = userEvent.setup();
  landing();
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Create a community" }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByLabelText("Invite link"),
    "https://relay.example/invite/v2.invite",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeVisible();
  expect(screen.getByDisplayValue("https://relay.example")).toBeVisible();
});

it("asks for the invite link when the pasted value is not one", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(screen.getByLabelText("Invite link"), "not a link");
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByText("Paste the invite link you were sent."),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("presents an opened invite and clears it on close", async () => {
  const user = userEvent.setup();
  const { onInviteClose } = landing({
    invite: { community: "https://relay.example", code: "x", requestId: 7 },
  });
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(onInviteClose).toHaveBeenCalledWith(7);
});

it("offers creating a community where hosting is available, and skipping", async () => {
  const user = userEvent.setup();
  const { onCreate, onSkip } = landing({ hosted: true });
  await user.click(screen.getByRole("button", { name: "Create a community" }));
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(onCreate).toHaveBeenCalledOnce();
  expect(onSkip).toHaveBeenCalledOnce();
});
