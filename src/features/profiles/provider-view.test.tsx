// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProfileProvidersContext } from "./provider-context";
import { useManagedProfile } from "./profile-source";
import type { RelaySession } from "../relay/session";
import type { ProfileProviders } from "./providers";
afterEach(cleanup);
it("reads saved metadata without a directory fetch, updates on metadata-only events, and hides on disable", () => {
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  let calls = 0;
  const provider = {
    id: "directory",
    key: "example/directory",
    matches: () => true,
    refresh: async () => {
      calls++;
      throw new Error("must not fetch peers");
    },
  };
  let entries = [provider];
  const registry: ProfileProviders = {
    register: () => {},
    snapshot: () => entries,
    subscribe,
  };
  const profile = { verified: { status: "checked", username: "bob" } };
  const profiles = new Map([["bob-key", profile]]);
  const saved = (city: string) => ({
    content: JSON.stringify({
      profile_extensions: {
        "example/directory": {
          username: "bob",
          data: {
            version: 1,
            source_label: "Directory",
            source_url: "https://example.org",
            fields: [],
            city,
          },
        },
      },
    }),
  });
  let event = saved("London");
  const session = {
    viewer: "alice-key",
    scope: "https://example.org:alice-key",
    profiles: { snapshot: () => profiles, subscribe, event: () => event },
  } as unknown as RelaySession;
  function View() {
    const data = useManagedProfile(session, "bob-key");
    return <span>{data?.city ?? "hidden"}</span>;
  }
  render(
    <ProfileProvidersContext.Provider value={registry}>
      <View />
    </ProfileProvidersContext.Provider>,
  );
  expect(screen.getByText("London")).toBeTruthy();
  act(() => {
    event = saved("Paris");
    listeners.forEach((fn) => {
      fn();
    });
  });
  expect(screen.getByText("Paris")).toBeTruthy();
  act(() => {
    entries = [];
    listeners.forEach((fn) => {
      fn();
    });
  });
  expect(screen.getByText("hidden")).toBeTruthy();
  expect(calls).toBe(0);
});
