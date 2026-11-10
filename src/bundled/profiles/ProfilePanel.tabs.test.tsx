// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { profileTarget } from "../../features/profiles/target";
import type {
  ProfileTab,
  ProfileTabs,
  RegisteredProfileTab,
} from "../../features/profiles/tabs";
import { ProfilePanel } from "./ProfilePanel";

const person = "a".repeat(64);
afterEach(cleanup);

function relay(): RelayData {
  const { session } = createRelaySession(null);
  const snapshot = { status: "ready" as const, generation: 1, session };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
}
function profileTabs(...tabs: ProfileTab[]): ProfileTabs {
  const registered: RegisteredProfileTab[] = tabs.map((tab) => ({
    ...tab,
    key: `example/${tab.id}`,
    pluginId: "example",
    revision: "one",
  }));
  return {
    register() {},
    snapshot: () => registered,
    subscribe: () => () => {},
  };
}

it("shows a plugin's tab between Info and Channels on a person's profile", async () => {
  const seen = vi.fn();
  const open = vi.fn(() => true);
  render(
    <ProfilePanel
      relay={relay()}
      target={profileTarget(person) ?? ""}
      context={{ channelId: "c", canOpen: () => true, open }}
      close={() => {}}
      profileTabs={profileTabs({
        id: "details",
        title: "Details",
        component: ({ pubkey, open }) => {
          seen(pubkey);
          return (
            <button type="button" onClick={() => open("nostr:npub1example")}>
              Plugin details
            </button>
          );
        },
      })}
    />,
  );
  const tabs = within(
    await screen.findByRole("tablist", { name: "Profile sections" }),
  ).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Info",
    "Details",
    "Channels",
  ]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Details" }));
  await user.click(screen.getByRole("button", { name: "Plugin details" }));
  expect(seen).toHaveBeenCalledWith(person);
  expect(open).toHaveBeenCalledWith("nostr:npub1example");
});

it("leaves out a tab whose `when` declines and an agent's profile", async () => {
  const tabs = profileTabs(
    { id: "never", title: "Never", component: () => null, when: () => false },
    {
      id: "broken",
      title: "Broken",
      component: () => null,
      when: () => {
        throw new Error("plugin failure");
      },
    },
    { id: "details", title: "Details", component: () => null },
  );
  const { unmount } = render(
    <ProfilePanel
      relay={relay()}
      target={profileTarget(person) ?? ""}
      close={() => {}}
      profileTabs={tabs}
    />,
  );
  await screen.findByRole("tab", { name: "Details" });
  expect(screen.queryByRole("tab", { name: "Never" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Broken" })).toBeNull();
  unmount();

  render(
    <ProfilePanel
      relay={relay()}
      target={profileTarget(person, { agent: true }) ?? ""}
      close={() => {}}
      profileTabs={tabs}
    />,
  );
  await screen.findByRole("tab", { name: "Info" });
  expect(screen.queryByRole("tab", { name: "Details" })).toBeNull();
});

it("contains a tab that throws while rendering", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <ProfilePanel
      relay={relay()}
      target={profileTarget(person) ?? ""}
      close={() => {}}
      profileTabs={profileTabs({
        id: "details",
        title: "Details",
        component: () => {
          throw new Error("plugin failure");
        },
      })}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Details" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Details is unavailable.",
  );
  await user.click(screen.getByRole("tab", { name: "Info" }));
  expect(screen.getByText("Public key")).toBeVisible();
});
