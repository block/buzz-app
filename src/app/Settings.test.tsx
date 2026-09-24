// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  ["./MessageSettings", "MessageSettings"],
  ["./DeveloperSettings", "DeveloperSettings"],
  ["../bundled/community-compute/CommunityComputePage", "CommunityComputePage"],
  ["../bundled/community-compute/CreditsSandbox", "CreditsSandbox"],
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
const host = {
  plugins: { subscribe: () => () => {}, snapshot: () => pluginState },
  communities: {},
} as unknown as Parameters<typeof Settings>[0];

it("gives grouped cards their own section and keeps others in Messages", () => {
  const { cards, set } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  render(<Settings {...host} cards={cards} />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Communities");
  expect(screen.queryByText("Hosted communities body")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Hosted communities" }));
  expect(screen.getByText("Hosted communities body")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Personal groups body")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Messages" }));
  expect(screen.getByText("Personal groups body")).toBeVisible();
  expect(screen.queryByText("Hosted communities body")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Hosted communities" }));
  act(() => set([card("groups", "Personal groups")]));
  expect(screen.queryByText("Hosted communities body")).toBeNull();
  expect(nav).not.toHaveTextContent("Communities");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
