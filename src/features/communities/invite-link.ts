import { communityDestination } from "./destination";

export type InviteLink = Readonly<{
  community: string;
  code: string;
  policyReceipt?: string;
}>;

/** Parse a relay invite without treating its URL as authority to join. */
export function parseInviteLink(input: string): InviteLink | null {
  if (input.length > 4096) return null;
  if (/^https?:\/\//.test(input)) {
    try {
      const url = new URL(input);
      if (
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        !/^\/invite\/[^/]+\/?$/.test(url.pathname)
      )
        return null;
      const code = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      if (!code || code.length > 256) return null;
      return { community: communityDestination(url.origin).url, code };
    } catch {
      return null;
    }
  }
  if (!input.startsWith("buzz://join?")) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "buzz:" ||
      url.host !== "join" ||
      url.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const relay = url.searchParams.getAll("relay");
    const codes = url.searchParams.getAll("code");
    const receipts = url.searchParams.getAll("policy_receipt");
    if (
      relay.length !== 1 ||
      codes.length !== 1 ||
      receipts.length > 1 ||
      !codes[0] ||
      codes[0].length > 256 ||
      !relay[0] ||
      (receipts.length === 1 && !receipts[0])
    )
      return null;
    // Unlike the reference's broad URL parser, the target transport is HTTPS-only.
    // Delegate origin validation to the same gate used by the manual join dialog.
    const community = communityDestination(relay[0]).url;
    return {
      community,
      code: codes[0],
      ...(receipts[0] ? { policyReceipt: receipts[0] } : {}),
    };
  } catch {
    return null;
  }
}
