import { communityRequest } from "../../features/communities/api";

/** Publish the community's NIP-11 icon as an inline image; "" removes it. */
export async function setCommunityIcon(community: string, icon: string) {
  const receipt = await communityRequest<{
    accepted?: boolean;
    message?: string;
  }>(community, "icon", { icon });
  if (!receipt.accepted)
    throw new Error(receipt.message || "The relay did not accept the change");
}
