// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { ChannelHeaderIdentity, memberAccess } from "./ChannelHeaderIdentity";

afterEach(cleanup);

const subscribe = () => () => {};
const list = { channels: [{ id: "channel", members: [] }] };
const profiles = new Map();
const choices = { identities: [] };
const session = {
  channels: {
    subscribeList: subscribe,
    list: () => list,
  },
  profiles: {
    subscribe,
    snapshot: () => profiles,
    ensure: vi.fn().mockResolvedValue(undefined),
  },
  agentChoices: { subscribe, snapshot: () => choices },
  media: (url: string) => url,
} as unknown as RelaySession;

const header = (isPrivate?: boolean) =>
  render(
    <ChannelHeaderIdentity
      session={session}
      channelId="channel"
      name="wen"
      private={isPrivate}
      access={memberAccess(undefined)}
    />,
  );

it("shows the sidebar's lock beside a private channel's name", () => {
  header(true);
  expect(screen.getByText("wen").previousElementSibling?.tagName).toBe("svg");
});

it("shows no lock beside a public channel's name", () => {
  header();
  expect(screen.getByText("wen").previousElementSibling).toBeNull();
});
