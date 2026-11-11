// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { profileTarget } from "../profiles/target";
import type { RelaySession } from "../relay/session";
import type { CommunityReader } from "./service";
import {
  CommunityWelcomeCard,
  DEFAULT_WELCOME_MESSAGE,
  WelcomeCard,
  WelcomeMessage,
} from "./WelcomeCard";

beforeEach(() => {
  // jsdom has no ResizeObserver; the card measures whether its body scrolls.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channel = "11111111-1111-4111-8111-111111111111";
const scope = `https://primary.example:${"0".repeat(64)}`;
const person = "a".repeat(64);
const joined = { status: "ready", channels: [] };
const session = {
  viewer: "0".repeat(64),
  media: () => undefined,
  channels: {
    list: () => joined,
    subscribeList: () => () => {},
  },
} as unknown as RelaySession;

function welcome(
  message: string | undefined,
  options: Partial<Parameters<typeof WelcomeMessage>[0]> = {},
) {
  return (
    <WelcomeCard title="Welcome to Primary">
      <WelcomeMessage
        message={message}
        session={session}
        scope={scope}
        channelId={channel}
        onOpenLink={() => false}
        {...options}
      />
    </WelcomeCard>
  );
}

it("titles the card and shows the default message", () => {
  render(welcome(undefined));
  const card = screen.getByRole("region", { name: "Welcome to Primary" });
  expect(card).toHaveTextContent(DEFAULT_WELCOME_MESSAGE);
});

it("renders a custom message as Markdown, never as HTML", () => {
  render(welcome("**Hi** <b>all</b>\nWelcome"));
  const card = screen.getByRole("region", { name: "Welcome to Primary" });
  expect(card.querySelector("strong")).toHaveTextContent("Hi");
  expect(card.querySelector("b")).toBeNull();
  // A single newline is a line break, as in messages.
  expect(card.querySelector("br")).not.toBeNull();
});

it("opens an identity link's profile from the timeline without notifying", async () => {
  const target = profileTarget(person);
  const onOpenLink = vi.fn(() => true);
  render(
    welcome(`Ask [@Ana](${target}) anything.`, {
      onOpenLink,
      canOpenLink: () => true,
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "View Ana profile" }),
  );
  expect(onOpenLink).toHaveBeenCalledWith(target);
});

it("shows an identity link as an inert chip when not interactive, as the editor's chips do", () => {
  const target = profileTarget(person);
  const view = render(
    welcome(`Ask [@Ana](${target}) anything.`, { interactive: false }),
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(
    view.container.querySelector(`[data-profile-target="${target}"]`),
  ).toHaveTextContent("Ana");
  expect(view.container.textContent).not.toContain(target);
});

it("titles the default with the community the viewer saved, else a custom title", () => {
  // A stable snapshot, as the real reader keeps it between changes.
  const saved = {
    memberships: [{ id: "https://primary.example", name: "Primary" }],
  };
  const communities = {
    snapshot: () => saved,
    subscribe: () => () => {},
  } as unknown as CommunityReader;
  const { rerender } = render(
    <CommunityWelcomeCard communities={communities} scope={scope}>
      Body
    </CommunityWelcomeCard>,
  );
  expect(
    screen.getByRole("region", { name: "Welcome to Primary" }),
  ).toBeVisible();
  rerender(
    <CommunityWelcomeCard
      communities={communities}
      scope={scope}
      title="Hello, newcomer"
    >
      Body
    </CommunityWelcomeCard>,
  );
  expect(screen.getByRole("region", { name: "Hello, newcomer" })).toBeVisible();
  rerender(
    <CommunityWelcomeCard scope="undefined:undefined">
      Body
    </CommunityWelcomeCard>,
  );
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
});

it("welcomes a community known only by its address without naming it", () => {
  const reader = (membership: Record<string, string>) => {
    const saved = {
      memberships: [{ id: "https://primary.example", ...membership }],
    };
    return {
      snapshot: () => saved,
      subscribe: () => () => {},
    } as unknown as CommunityReader;
  };
  const { rerender } = render(
    <CommunityWelcomeCard
      communities={reader({ name: "primary.example" })}
      scope={scope}
    >
      Body
    </CommunityWelcomeCard>,
  );
  // Joined without a published name, the membership holds only the host.
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
  rerender(
    <CommunityWelcomeCard
      communities={reader({
        name: "primary.example",
        publishedName: "Primary",
      })}
      scope={scope}
    >
      Body
    </CommunityWelcomeCard>,
  );
  expect(
    screen.getByRole("region", { name: "Welcome to Primary" }),
  ).toBeVisible();
  rerender(
    <CommunityWelcomeCard
      communities={reader({ name: "primary.example", localName: "Home" })}
      scope={scope}
    >
      Body
    </CommunityWelcomeCard>,
  );
  expect(screen.getByRole("region", { name: "Welcome to Home" })).toBeVisible();
});
