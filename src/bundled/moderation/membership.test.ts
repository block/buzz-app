import { expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { createCommunityMembership, canManageMembership } from "./membership";

const relayKey = "f".repeat(64);
const viewer = "a".repeat(64);
const roster = (role: "owner" | "admin" | "member") => ({
  id: role.padEnd(64, "0"),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [["member", viewer, role]],
});

function setup(role: "owner" | "admin" | "member") {
  const listeners = new Set<() => void>();
  const read = vi.fn(async () => [roster(role)]);
  const ensureProfiles = vi.fn(async () => {});
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session: {
      relayAuthor: relayKey,
      read,
      profiles: { ensure: ensureProfiles },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ relayAuthor: relayKey })),
  );
  const membership = createCommunityMembership({
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData);
  return { membership, read, ensureProfiles };
}

for (const [role, allowed] of [
  ["owner", true],
  ["admin", true],
  ["member", false],
] as const)
  it(`projects ${role} navigation authorization from the verified roster`, async () => {
    const { membership, read, ensureProfiles } = setup(role);
    const changed = new Promise<void>((resolve) => {
      const stop = membership.subscribe(() => {
        if (membership.snapshot().status === "ready") {
          stop();
          resolve();
        }
      });
    });
    const release = membership.ensure();
    await changed;
    release();
    expect(canManageMembership(membership.snapshot())).toBe(allowed);
    expect(ensureProfiles).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [13534], authors: [relayKey], limit: 1 }],
      expect.objectContaining({ fresh: true }),
    );
    membership.dispose();
    vi.unstubAllGlobals();
  });
