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
import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../plugins/contributions";
import type { SettingsCard, SettingsCards } from "../features/settings/service";

afterEach(cleanup);

function registry(initial: Contribution<SettingsCard>[]) {
  let entries: readonly Contribution<SettingsCard>[] = initial;
  const listeners = new Set<() => void>();
  const cards: SettingsCards = {
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register() {},
  };
  return {
    cards,
    set(next: Contribution<SettingsCard>[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
  };
}
const card = (
  id: string,
  title: string,
  group?: string,
): Contribution<SettingsCard> =>
  Object.freeze({
    id,
    title,
    ...(group ? { group } : {}),
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    component: () => <p>{title} body</p>,
  });
// Built-in sections have their own tests; this file covers plugin card placement.
for (const [path, name] of [
  ["./NotificationSettings", "NotificationSettings"],
  ["./AppearanceSettings", "AppearanceSettings"],
  ["./ShortcutSettings", "ShortcutSettings"],
  ["./ProfileSettings", "ProfileSettings"],
  ["./AgentSettings", "AgentSettings"],
  ["./DeveloperSettings", "DeveloperSettings"],
  ["../features/updates/UpdateSettings", "UpdateSettings"],
] as const)
  vi.doMock(path, () => ({ [name]: () => null }));
const { Settings } = await import("./Settings");
const pluginState = {
  configuration: { status: "loading" },
  activation: {},
  busy: false,
  error: null,
  refreshError: null,
};
const communityState = {
  status: "ready",
  viewer: "ab".repeat(32),
  profile: { name: "Buzz User", picture: "" },
  memberships: [{ id: "primary", name: "Primary" }],
  selected: "primary",
};
const host = {
  plugins: { subscribe: () => () => {}, snapshot: () => pluginState },
  communities: {
    subscribe: () => () => {},
    snapshot: () => communityState,
  },
} as unknown as Parameters<typeof Settings>[0];

it("keeps grouped cards available without a selected community", () => {
  const { cards } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const noCommunityState = { ...communityState, selected: null };
  render(
    <Settings
      {...host}
      communities={
        {
          subscribe: () => () => {},
          snapshot: () => noCommunityState,
        } as unknown as Parameters<typeof Settings>[0]["communities"]
      }
      cards={cards}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Communities");
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Personal groups" })).toBeNull();
});

it("gives contributed cards their own community sections and retires removed cards", async () => {
  const { cards, set } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const complete = vi.fn(() => true);
  const onSection = vi.fn();
  render(
    <Settings
      {...host}
      cards={cards}
      navigation={
        {
          target: {
            version: 1,
            kind: "settings",
            section: "example/hosted",
          },
          complete,
        } as never
      }
      onSection={onSection}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Primary");
  expect(nav).toHaveTextContent("Communities");
  expect(await screen.findByText("Hosted communities body")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Personal groups body")).toBeNull();
  expect(complete).toHaveBeenLastCalledWith({ status: "opened" });

  act(() => set([card("groups", "Personal groups")]));
  await waitFor(() => expect(onSection).toHaveBeenLastCalledWith("profile"));
  expect(screen.queryByText("Hosted communities body")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(nav).not.toHaveTextContent("Hosted communities");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
});

it("keeps same-id community cards from different plugins distinct", () => {
  const { cards } = registry([
    card("groups", "Example groups"),
    {
      ...card("groups", "Other groups"),
      key: "other/groups",
      pluginId: "other",
    },
  ]);
  render(<Settings {...host} cards={cards} />);
  fireEvent.click(screen.getByRole("button", { name: "Other groups" }));
  expect(screen.getByText("Other groups body")).toBeVisible();
  expect(screen.queryByText("Example groups body")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Example groups" }),
  ).not.toHaveAttribute("aria-current");
});
