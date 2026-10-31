// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ClientSnapshot } from "../../features/communities/service";
import type { Profile } from "../../features/relay/contracts";
import { communityFixture } from "./agents/community-testing";
import { formatPublicKey } from "../../shared/identity/public-key";
import { LinkedIdentity } from "./LinkedIdentity";

afterEach(cleanup);
it("uses the local default only in Personal space and never for another key", async () => {
  const h = communityFixture(null);
  const state = {
    ...h.reader.snapshot(),
    profile: { name: "Local Alex", picture: "", about: "Local bio" },
  };
  const communities = { ...h.reader, snapshot: () => state };
  const view = render(
    <LinkedIdentity
      pubkey={h.viewer}
      communities={communities}
      relay={h.relay}
    />,
  );
  try {
    expect(screen.getByText("Local Alex")).toBeVisible();
    expect(screen.getByText("Local bio")).toBeVisible();
    expect(
      screen.getByText("Local default profile · Personal space"),
    ).toBeVisible();
    expect(
      screen.getByText(formatPublicKey(h.viewer, 8) ?? "missing key"),
    ).toBeVisible();
    view.rerender(
      <LinkedIdentity
        pubkey={"a".repeat(64)}
        communities={communities}
        relay={h.relay}
      />,
    );
    expect(screen.queryByText("Local Alex")).not.toBeInTheDocument();
    expect(
      screen.getByText("Profile unavailable for this identity"),
    ).toBeVisible();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("uses only the selected session's profile and drops stale profile data on scope changes", async () => {
  const h = communityFixture();
  let state: ClientSnapshot = {
    ...h.reader.snapshot(),
    memberships: [
      { id: "https://community.example", name: "Design" },
      { id: "https://other.example", name: "Research" },
    ],
    profile: { name: "Local Alex", picture: "" },
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  let profiles: ReadonlyMap<string, Profile> = new Map();
  const profileListeners = new Set<() => void>();
  const snapshot = {
    ...h.relay.snapshot(),
    session: {
      ...h.relay.snapshot().session,
      profiles: {
        ...h.relay.snapshot().session.profiles,
        snapshot: () => profiles,
        subscribe: (fn: () => void) => {
          profileListeners.add(fn);
          return () => {
            profileListeners.delete(fn);
          };
        },
      },
    },
  };
  const relay = { ...h.relay, snapshot: () => snapshot };
  const view = render(
    <LinkedIdentity
      pubkey={h.viewer}
      communities={communities}
      relay={relay}
    />,
  );
  try {
    expect(screen.queryByText("Local Alex")).not.toBeInTheDocument();
    expect(screen.getByText("Profile unavailable in Design")).toBeVisible();
    act(() => {
      profiles = new Map([
        [h.viewer, { name: "Community Alex", about: "Design bio" }],
      ]);
      for (const fn of profileListeners) fn();
    });
    expect(await screen.findByText("Community Alex")).toBeVisible();
    expect(screen.getByText("Profile in Design")).toBeVisible();
    act(() => {
      state = { ...state, selected: "https://other.example" };
      for (const fn of listeners) fn();
    });
    expect(screen.queryByText("Community Alex")).not.toBeInTheDocument();
    expect(screen.queryByText("Design bio")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Alex")).not.toBeInTheDocument();
    expect(screen.getByText("Profile unavailable in Research")).toBeVisible();
    act(() => {
      state = { ...state, selected: null };
      for (const fn of listeners) fn();
    });
    expect(screen.getByText("Local Alex")).toBeVisible();
  } finally {
    view.unmount();
    await h.dispose();
  }
});
