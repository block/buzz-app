import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { signed, type Key } from "../../features/relay/testing";
import type { ChannelSummary } from "../../features/relay/contracts";

export function reviewAgentProfile(owner: Key, agent: Key) {
  const proof = bytesToHex(
    schnorr.sign(
      new Uint8Array(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
      ),
      owner.secret,
    ),
  );
  return signed(agent, {
    kind: 0,
    content: "{}",
    tags: [["auth", owner.pubkey, "", proof]],
  });
}

export function reviewTestAccess(
  viewer: string,
  id: string,
  agents: readonly string[] = [],
) {
  const channel: ChannelSummary = {
    id,
    name: "Reviews",
    channelType: "stream",
    visibility: "private",
    viewerRole: "member",
    members: [viewer, ...agents],
  };
  const list = { status: "ready" as const, channels: [channel] };
  return {
    viewer,
    channels: {
      list: () => list,
      ensureList() {},
      subscribeList: () => () => {},
      refreshRoster: async () => true,
    },
    channelDetails: { load: async () => ({ visibility: "private" as const }) },
  };
}
