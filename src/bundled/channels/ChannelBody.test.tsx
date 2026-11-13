// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReadError } from "../../features/relay/errors";
import { ApiPaused } from "../../features/relay/http-admission";
import type { WindowFailure } from "../../features/relay/window-failure";
import { UPDATES_LINK } from "../../features/messages/history-failure";
import { ChannelBody } from "./ChannelBody";

const conversation = {
  ensure: vi.fn(),
  onOpenLink: vi.fn((_url: string) => true),
};
let failure: WindowFailure | undefined;
let recovers = false;
vi.mock("../../features/conversation/Conversation", () => ({
  useConversation: () => ({
    session: { channels: { ensure: conversation.ensure } },
    channelId: "alpha",
    ownSoloConversation: false,
    onOpenLink: conversation.onOpenLink,
  }),
  ConversationTimeline: () => null,
}));
vi.mock("../../features/relay/react", () => ({
  useChannelWindow: () => ({
    channelId: "alpha",
    status: "error",
    rows: [],
    hasMore: false,
    loadingOlder: false,
    error: failure,
  }),
}));
vi.mock("../../features/relay/RecoveryNotice", () => ({
  useRecoveryOwns: () => recovers,
}));
vi.mock("../../features/developer/client-metrics", () => ({
  clientMetrics: {
    channelMounted() {},
    channelUnmounted() {},
    channelRendered() {},
    channelEmpty() {},
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  recovers = false;
});

function show(error: WindowFailure) {
  failure = error;
  render(<ChannelBody cached={false} />);
  return screen.getByRole("alert");
}

it.each([
  {
    name: "a server error",
    error: new ReadError("unavailable", "Relay read failed (503)", 503),
  },
  { name: "a native timeout", error: "network-timeout" },
  { name: "an unknown failure", error: new Error("boom") },
])("says messages didn’t load and offers Try again for $name", ({ error }) => {
  const alert = show(error);
  expect(alert).toHaveTextContent("Messages didn’t load.");
  expect(alert).not.toHaveTextContent(/relay|503|network-timeout|boom/i);
  expect(
    screen.queryByRole("button", { name: "Check for updates" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(conversation.ensure).toHaveBeenCalledWith("alpha");
});

it("says a busy Buzz can try again", () => {
  const alert = show(new ApiPaused(3000));
  expect(alert).toHaveTextContent(
    "Messages didn’t load. Buzz is busy. Try again in a few seconds.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

it("offers only Check for updates for an answer Buzz can't use", () => {
  const alert = show(
    new ReadError("invalid-response", "Relay response is not an event array"),
  );
  expect(alert).toHaveTextContent("Messages didn’t load.");
  expect(alert).not.toHaveTextContent(/event array|relay/i);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(conversation.onOpenLink).toHaveBeenCalledExactlyOnceWith(UPDATES_LINK);
});

it("offers no button for a refusal and shows no raw text or Details", () => {
  const alert = show(new ReadError("denied", "Relay read failed (403)", 403));
  expect(alert).toHaveTextContent(
    "Messages didn’t load. You don’t have access to this conversation.",
  );
  expect(alert).not.toHaveTextContent(/relay|403/i);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Check for updates" }),
  ).toBeNull();
  expect(screen.queryByText("Details")).toBeNull();
});

it("leaves the empty timeline to the recovery notice while recovery retries", () => {
  recovers = true;
  failure = new ReadError("unavailable", "Relay read failed (503)", 503);
  render(<ChannelBody cached={false} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
