// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { ManagedProfile } from "../../features/profiles/managed-profile";
import type { Profile } from "../../features/relay/contracts";
import * as providerProfile from "./provider-profile";
import { ProfileInfoBento } from "./ProfileInfoBento";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("preserves provider labels and additional fields in each declared section", () => {
  const owner = createRelaySession(null);
  const fields: ManagedProfile["fields"] = [
    {
      key: "email",
      section: "personal",
      label: "Contact address",
      value: "person@example.org",
    },
    {
      key: "pronouns",
      section: "personal",
      label: "Pronouns",
      value: "they/them",
    },
    {
      key: "team",
      section: "team",
      label: "Working group",
      value: "Design systems",
    },
    {
      key: "mentor",
      section: "team",
      label: "Mentor",
      value: "Example Mentor",
      username: "mentor",
    },
    {
      key: "office",
      section: "location",
      label: "Office",
      value: "North campus",
    },
  ];
  try {
    render(
      <ProfileInfoBento
        picture={undefined}
        managed={{
          version: 1,
          source_label: "Directory",
          source_url: "https://example.org/directory",
          fields,
        }}
        npub="npub1example"
        username="person"
        about={undefined}
        timeZone={undefined}
        session={owner.session}
        open={vi.fn()}
      />,
    );
    const personal = within(
      screen.getByRole("region", { name: "Personal info" }),
    );
    expect(personal.getByText("Username")).toBeVisible();
    expect(personal.queryByText("LDAP")).toBeNull();
    expect(personal.getByText("Pronouns")).toBeVisible();
    expect(personal.getByText("they/them")).toBeVisible();
    expect(
      personal.getByRole("button", { name: "Copy contact address" }),
    ).toHaveTextContent("person@example.org");
    const team = within(screen.getByRole("region", { name: "Team" }));
    expect(team.getByText("Working group")).toBeVisible();
    expect(team.getByText("Design systems")).toBeVisible();
    expect(team.getByText("Mentor")).toBeVisible();
    expect(
      team.getByRole("button", { name: "Open Example Mentor’s profile" }),
    ).toBeEnabled();
    const location = within(screen.getByRole("region", { name: "Location" }));
    expect(location.getByText("Office")).toBeVisible();
    expect(location.getByText("North campus")).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("updates the lead photo from the shared profile and respects photo removal and verification changes", async () => {
  const owner = createRelaySession(null);
  const leadKey = "c".repeat(64);
  const verified = {
    displayName: "Example Lead",
    username: "lead",
    issuerLabel: "Directory",
    verifiedAt: 1,
    status: "checked" as const,
    multipleIssuers: false,
    managed: {
      version: 1 as const,
      source_label: "Directory",
      source_url: "https://example.org/directory",
      fields: [],
      picture: "https://example.org/directory-default.png",
    },
  };
  let snapshot = new Map<string, Profile>([
    [
      leadKey,
      {
        name: "Example Lead",
        verified,
        picture: "https://example.org/chosen.png",
      },
    ],
  ]);
  const listeners = new Set<() => void>();
  const ensure = vi.fn().mockResolvedValue(undefined);
  const session = {
    ...owner.session,
    media: (url: string) => url,
    profiles: {
      ...owner.session.profiles,
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure,
    },
  };
  vi.spyOn(providerProfile, "resolveProviderProfile").mockResolvedValue(
    leadKey,
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No directory request expected"));
  const publish = (profile: Profile) =>
    act(async () => {
      snapshot = new Map([[leadKey, profile]]);
      for (const listener of listeners) listener();
    });
  try {
    render(
      <ProfileInfoBento
        picture={undefined}
        managed={{
          version: 1,
          source_label: "Directory",
          source_url: "https://example.org/directory",
          fields: [
            {
              key: "lead",
              section: "team",
              label: "Led by",
              value: "Example Lead",
              username: "lead",
            },
          ],
        }}
        npub="npub1example"
        username="person"
        about={undefined}
        timeZone={undefined}
        session={session}
        open={undefined}
      />,
    );
    const team = screen.getByRole("region", { name: "Team" });
    await waitFor(() =>
      expect(team.querySelector("img")).toHaveAttribute(
        "src",
        "https://example.org/chosen.png",
      ),
    );
    expect(ensure).toHaveBeenCalledWith([leadKey], "background");
    await publish({
      name: "Example Lead",
      verified,
    });
    expect(team.querySelector("img")).toBeNull();
    expect(team.querySelector("[data-avatar-fallback]")).toHaveTextContent("E");
    await publish({
      name: "Example Lead",
      verified,
      picture: "https://example.org/replacement.png",
    });
    await waitFor(() =>
      expect(team.querySelector("img")).toHaveAttribute(
        "src",
        "https://example.org/replacement.png",
      ),
    );
    await publish({
      name: "Example Lead",
      verified: { ...verified, username: "someone-else" },
      picture: "https://example.org/replacement.png",
    });
    expect(team.querySelector("img")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});
