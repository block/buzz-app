import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";

export const generalAccessOptions = {
  private: {
    value: "private",
    label: "Private",
    description: "Only people you add can access.",
  },
  "view-only": {
    value: "view-only",
    label: "View only",
    description: "Anyone in the community can read.",
  },
  public: {
    value: "public",
    label: "Public",
    description: "Anyone in the community can participate.",
  },
} as const;

export type GeneralAccess = keyof typeof generalAccessOptions;
type Policy = Pick<ChannelDetailsDraft, "visibility" | "joinRole">;

export function generalAccessValue(policy: Policy): GeneralAccess {
  return policy.visibility === "private"
    ? "private"
    : policy.joinRole === "guest"
      ? "view-only"
      : "public";
}

/** Private retains the admission default; open policies state it explicitly. */
export function generalAccessPolicy(
  access: GeneralAccess,
  joinRole: Policy["joinRole"],
): Policy {
  return {
    visibility: access === "private" ? "private" : "public",
    joinRole:
      access === "private"
        ? joinRole
        : access === "view-only"
          ? "guest"
          : "member",
  };
}

export const OPENING_BLOCKED_REASON =
  "Has other members. Create a new public channel instead.";

/** Whether the relay will refuse to open this private channel: it has a member
 * who is neither the viewer nor one of the viewer's own agents (NIP-OA). The
 * relay decides; this only predicts it, so missing or unverified ownership
 * never blocks. A member blocks only with evidence: a verified owner who is
 * someone else, or a loaded profile that claims no agent at all, read as a
 * person once the viewer's agent inventory is complete. That reading is a
 * guess: an untagged agent of the viewer's missing from the inventory also
 * blocks here, though the relay would allow it. */
export function openingBlocked(
  session: {
    viewer?: string | undefined;
    profiles: {
      snapshot(): ReadonlyMap<
        string,
        { isAgent?: true | undefined; ownerPubkey?: string | undefined }
      >;
      owner?(pubkey: string): string | undefined;
    };
    agentChoices: {
      snapshot(): {
        identities: readonly { pubkey: string }[];
        complete: boolean;
      };
    };
  },
  members: readonly string[] | undefined,
) {
  const viewer = session.viewer;
  const others = members?.filter((pubkey) => pubkey !== viewer) ?? [];
  if (!viewer || !others.length) return false;
  const profiles = session.profiles.snapshot();
  const choices = session.agentChoices.snapshot();
  const inventory = new Set(choices.identities.map((agent) => agent.pubkey));
  return others.some((pubkey) => {
    if (inventory.has(pubkey)) return false;
    const owner = session.profiles.owner?.(pubkey);
    if (owner) return owner !== viewer;
    const profile = profiles.get(pubkey);
    return (
      choices.complete && !!profile && !profile.isAgent && !profile.ownerPubkey
    );
  });
}
