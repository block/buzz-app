// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderProfileRow } from "./ProviderProfileRow";
import { searchedProfiles } from "../../features/relay/profile-search";
import type { RelaySession } from "../../features/relay/session";
import { profileTarget } from "../../features/profiles/target";
vi.mock("../../features/relay/profile-search", () => ({
  searchedProfiles: vi.fn(),
}));
afterEach(cleanup);
const key = "a".repeat(64);
it("opens only an exact checked identity and preserves the profile target", async () => {
  vi.mocked(searchedProfiles).mockReturnValue(
    new Map([[key, { name: "Lead" }]]),
  );
  const open = vi.fn();
  const session = {
    searchProfiles: vi.fn(async () => []),
    profiles: {},
    directMessages: {
      verified: vi.fn(async () => ({
        profiles: new Map([[key, { status: "checked", username: "lead" }]]),
      })),
    },
  } as unknown as RelaySession;
  render(
    <ProviderProfileRow
      title="Led by"
      value="Lead"
      username="lead"
      session={session}
      open={open}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(open).toHaveBeenCalledWith(profileTarget(key)));
  expect(session.directMessages.verified).toHaveBeenCalledWith(
    [key],
    expect.any(AbortSignal),
  );
});
it("does not navigate to a display-name match without checked identity", async () => {
  vi.mocked(searchedProfiles).mockReturnValue(
    new Map([[key, { name: "lead" }]]),
  );
  const open = vi.fn();
  const session = {
    searchProfiles: vi.fn(async () => []),
    profiles: {},
    directMessages: { verified: vi.fn(async () => ({ profiles: new Map() })) },
  } as unknown as RelaySession;
  render(
    <ProviderProfileRow
      title="Led by"
      value="Lead"
      username="lead"
      session={session}
      open={open}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect((await screen.findByRole("status")).textContent).toContain(
    "Profile unavailable",
  );
  expect(open).not.toHaveBeenCalled();
});
