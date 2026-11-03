// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { getEventHash } from "nostr-tools";
import { afterEach, assert, expect, it } from "vitest";
import {
  completeTemplate,
  consentTemplate,
  withdrawTemplate,
} from "../conversation-import/protocol";
import type { Profile } from "../relay/contracts";
import { foldMessages } from "../relay/fold";
import { ImportNoticeRow } from "./ImportNoticeRow";

afterEach(cleanup);

const viewer = "a".repeat(64);
const partner = "b".repeat(64);
const relayKey = "c".repeat(64);
const channel = "f0".repeat(16);
const proposalId = "1".repeat(64);

function row(
  pubkey: string,
  template: { kind: number; content: string; tags: string[][] },
) {
  const unsigned = { ...template, pubkey, created_at: 1_740_000_000 };
  const [folded] = foldMessages(channel, relayKey, [
    { ...unsigned, id: getEventHash(unsigned) },
  ]);
  assert.exists(folded?.importRecord);
  return folded;
}

const profiles: ReadonlyMap<string, Profile> = new Map([
  [partner, { name: "Partner Person" } as Profile],
]);
const proposal = {
  id: proposalId,
  channelId: channel,
  manifest: "d".repeat(64),
  proposer: viewer,
};

it("renders consent, withdrawal and completion as quiet notices", () => {
  const accepted = row(
    partner,
    consentTemplate(proposal, "accept", "3".repeat(64)),
  );
  const { container } = render(
    <ImportNoticeRow row={accepted} profiles={profiles} viewer={viewer} day />,
  );
  expect(container.querySelector("[data-import-notice-row]")).toBeTruthy();
  expect(container.textContent).toContain(
    "Partner Person accepted the conversation import",
  );
  cleanup();
  render(
    <ImportNoticeRow
      row={row(viewer, withdrawTemplate(proposalId, channel, "Wrong channel"))}
      profiles={profiles}
      viewer={viewer}
      day={false}
    />,
  );
  expect(screen.getByText("You")).toBeTruthy();
  expect(
    screen.getByText(/withdrew the conversation import: Wrong channel/),
  ).toBeTruthy();
  cleanup();
  render(
    <ImportNoticeRow
      row={row(
        partner,
        completeTemplate(proposalId, channel, { messages: 1, reactions: 2 }),
      )}
      profiles={profiles}
      viewer={viewer}
      day={false}
      resolveName={() => "Resolved Name"}
    />,
  );
  expect(screen.getByText("Resolved Name")).toBeTruthy();
  expect(
    screen.getByText(/finished importing 1 message and 2 reactions/),
  ).toBeTruthy();
});

it("renders nothing for an ordinary message", () => {
  const unsigned = {
    kind: 9,
    content: "hello",
    tags: [["h", channel]],
    pubkey: partner,
    created_at: 1_740_000_000,
  };
  const [plain] = foldMessages(channel, relayKey, [
    { ...unsigned, id: getEventHash(unsigned) },
  ]);
  assert.exists(plain);
  const { container } = render(
    <ImportNoticeRow row={plain} profiles={profiles} day={false} />,
  );
  expect(container.textContent).toBe("");
});
