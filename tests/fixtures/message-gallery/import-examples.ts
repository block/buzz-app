import { getEventHash } from "nostr-tools";
import {
  completeTemplate,
  consentTemplate,
  proposalTemplate,
} from "../../../src/features/conversation-import/protocol";
import type {
  ConversationImportService,
  ImportProposalInput,
  ImportSessionView,
} from "../../../src/features/conversation-import/types";
import type { Profile } from "../../../src/features/relay/contracts";
import type { RelayData } from "../../../src/features/relay/service";

// Synthetic identities shared with the other gallery examples.
const reader = "a".repeat(64);
const teammate = "b".repeat(64);
const relayKey = "e".repeat(64);
const channel = "studio";
const proposedAt = 1_790_078_400;

const input: ImportProposalInput = {
  channelId: channel,
  source: {
    type: "slack",
    conversation: "1".repeat(64),
    kind: "private_channel",
    label: "#design-review",
  },
  range: { from: 1_788_000_000, to: 1_790_000_000 },
  participants: [
    {
      pubkey: reader,
      source_user: "2".repeat(64),
      messages: 214,
      reactions: 58,
    },
    {
      pubkey: teammate,
      source_user: "3".repeat(64),
      messages: 167,
      reactions: 41,
    },
  ],
  excluded_authors: 1,
  manifest: "4f9c2a1e7b3d8c60".repeat(4),
  expires_at: proposedAt + 30 * 86_400,
};

function stamp(
  pubkey: string,
  template: { kind: number; content: string; tags: string[][] },
  created_at: number,
) {
  const unsigned = { ...template, pubkey, created_at };
  return { ...unsigned, id: getEventHash(unsigned), sig: "0".repeat(128) };
}

export const importProposal = stamp(
  teammate,
  proposalTemplate(input),
  proposedAt,
);
const record = {
  id: importProposal.id,
  channelId: channel,
  manifest: input.manifest,
  proposer: teammate,
};
export const importRecords = [
  stamp(
    reader,
    consentTemplate(record, "accept", "2".repeat(64)),
    proposedAt + 60,
  ),
  stamp(
    reader,
    completeTemplate(importProposal.id, channel, {
      messages: 214,
      reactions: 58,
    }),
    proposedAt + 120,
  ),
];
export const importedMessages = [
  stamp(
    teammate,
    {
      kind: 9,
      content: "Here is the second pass on the onboarding flow.",
      tags: [
        ["h", channel],
        ["import", importProposal.id],
        ["source", "slack", "1789990000.000100"],
      ],
    },
    1_789_990_000,
  ),
  stamp(
    reader,
    {
      kind: 9,
      content: "Looks good. I tightened the copy on step two.",
      tags: [
        ["h", channel],
        ["import", importProposal.id],
        ["source", "slack", "1789990120.000200"],
        ["source-edited", "1"],
      ],
    },
    1_789_990_120,
  ),
];
export { relayKey as importRelayKey };

const verified = (displayName: string, username: string): Profile => ({
  name: displayName,
  verified: {
    displayName,
    username,
    issuerLabel: "Example Directory",
    verifiedAt: 1_780_000_000,
    status: "checked",
    multipleIssuers: false,
  },
});
const importProfiles = new Map<string, Profile>([
  [reader, verified("Alex Morgan", "alex.morgan")],
  [teammate, verified("Sam Rivera", "sam.rivera")],
]);
const session = {
  profiles: {
    snapshot: () => importProfiles,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  channels: { list: () => ({ channels: [] }) },
};
const connection = { session, viewer: reader, status: "ready" };
export const importRelay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;

const view: ImportSessionView = {
  proposalId: importProposal.id,
  channelId: channel,
  proposer: teammate,
  proposedAt,
  proposal: (({ channelId: _, ...rest }) => rest)(input),
  status: "proposed",
  required: [reader, teammate],
  consents: { [teammate]: "accept" },
  published: {},
  completed: [],
  expires_at: input.expires_at,
  confirmed: true,
};
const views = [view];
export const importService = {
  session: (id: string) => (id === view.proposalId ? view : undefined),
  subscribe: (cb: (sessions: readonly ImportSessionView[]) => void) => {
    cb(views);
    return () => {};
  },
  consent: async () => {},
  withdraw: async () => {},
} as unknown as ConversationImportService;
