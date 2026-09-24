// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  within,
  fireEvent,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { createRelaySession } from "../../features/relay/session";
import { bindNames } from "../../features/identity-names/service";
import { agentDirectory } from "../../features/identity-names/testing";
import { LegacyAgentLibrary } from "./LegacyAgentLibrary";
afterEach(cleanup);
it("renders linked identities as separate named tiles while retaining profile-only entries", async () => {
  const keys = ["a".repeat(64), "b".repeat(64)];
  const owned = createRelaySession({
    viewer: "c".repeat(64),
    relayAuthor: "d".repeat(64),
    scope: "wss://here.test",
    query: async () => [],
    media: () => undefined,
    readAgentLibrary: async () => ({
      definitions: [
        { id: "linked", name: "Larry" },
        { id: "empty", name: "Empty" },
      ],
      identities: keys.map((pubkey) => ({
        pubkey,
        name: "Larry",
        definitionId: "linked",
      })),
    }),
  });
  const names = bindNames(owned.session, {
    snapshot: () => [agentDirectory],
    subscribe: () => () => {},
  });
  const mounted = render(
    <LegacyAgentLibrary session={{ ...owned.session, names }} />,
  );
  try {
    for (const key of keys) {
      const label = `Larry · ${npubEncode(key).slice(-4)}`;
      const card = await screen.findByRole("article", {
        name: `Agent ${label}`,
      });
      fireEvent.click(within(card).getByRole("button", { name: "Public key" }));
      expect(within(card).getByText(key)).toBeTruthy();
    }
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(
      within(
        screen.getByRole("region", { name: "Profiles without identities" }),
      ).getByText("Empty"),
    ).toBeTruthy();
  } finally {
    mounted.unmount();
    names.dispose();
    owned.dispose();
  }
});
