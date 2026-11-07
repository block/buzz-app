import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, test } from "vitest";
import {
  MEMBERSHIP_BYTES,
  MEMBERSHIP_TYPES,
  MembershipUnsupported,
  membershipCapability,
  membershipDisabled,
  membershipIdentity,
  membershipText,
  parseMembershipSnapshot,
  type ViewerMembership,
} from "./membership-snapshot";

const relayKey = generateSecretKey();
const relay = getPublicKey(relayKey);
const viewer = getPublicKey(generateSecretKey());
const community = "10000000-0000-0000-0000-000000000000";
const requestId = "ab".repeat(32);
const descriptor = {
  version: 1,
  community_id: community,
  pubkey: relay,
  kind: 39008,
  max_channels: 4096,
  max_response_bytes: MEMBERSHIP_BYTES,
};
const capability = membershipCapability(descriptor, relay);
if (!capability) throw new Error("Test membership capability missing");
const binding = {
  origin: "https://relay.test:9443",
  viewer,
  requestId,
  capability,
};
const entries: [ViewerMembership, ViewerMembership] = [
  {
    id: "20000000-0000-0000-0000-000000000000",
    role: "guest",
    channel_type: "system",
    visibility: "private",
    archived: true,
  },
  {
    id: "30000000-0000-0000-0000-000000000000",
    role: "admin",
    channel_type: "dm",
    visibility: "private",
    archived: false,
  },
];
async function payload(channels: readonly ViewerMembership[] = entries) {
  return {
    version: 1,
    community_id: community,
    host: "relay.test:9443",
    viewer,
    request_id: requestId,
    types: [...MEMBERSHIP_TYPES],
    complete: true,
    snapshot_id: await membershipIdentity(
      community,
      viewer,
      MEMBERSHIP_TYPES,
      channels,
    ),
    channels,
  };
}
function signed(content: unknown, event = {}) {
  return {
    membership_snapshot: 1,
    event: finalizeEvent(
      {
        kind: 39008,
        created_at: 1,
        tags: [
          ["d", requestId],
          ["p", viewer],
        ],
        content: JSON.stringify(content),
        ...event,
      },
      relayKey,
    ),
  };
}

describe("NIP-CL compact membership authority", () => {
  test("negotiates only explicit support and pins the advertised key", () => {
    expect(membershipCapability(undefined, relay)).toBeUndefined();
    expect(
      membershipCapability({ ...descriptor, version: 2 }, relay),
    ).toBeUndefined();
    for (const change of [
      { pubkey: viewer },
      { kind: 39002 },
      { community_id: "bad" },
      { max_channels: 0 },
      { max_response_bytes: MEMBERSHIP_BYTES + 1 },
      { version: "1" },
    ])
      expect(() =>
        membershipCapability({ ...descriptor, ...change }, relay),
      ).toThrow();
    expect(
      membershipDisabled(404, { error: "membership_snapshot unsupported" }),
    ).toBe(true);
    for (const status of [401, 403, 413, 429, 503])
      expect(
        membershipDisabled(status, {
          error: "membership_snapshot unsupported",
        }),
      ).toBe(false);
    expect(membershipDisabled(404, { error: "not found" })).toBe(false);
    expect(
      membershipDisabled(404, {
        error: "membership_snapshot unsupported",
        partial: true,
      }),
    ).toBe(false);
  });

  test("verifies signed empty or scoped memberships without using the event clock as freshness", async () => {
    const result = await parseMembershipSnapshot(
      signed(await payload()),
      binding,
    );
    expect(result.channels).toEqual(entries);
    expect(Object.isFrozen(result.channels)).toBe(true);
    expect(
      (await parseMembershipSnapshot(signed(await payload([])), binding))
        .channels,
    ).toEqual([]);
    const single = [entries[1]];
    const content = {
      ...(await payload(single)),
      types: ["dm"],
      snapshot_id: await membershipIdentity(community, viewer, ["dm"], single),
    };
    expect(
      (
        await parseMembershipSnapshot(signed(content), {
          ...binding,
          types: ["dm"],
        })
      ).channels,
    ).toEqual(single);
  });

  test("rejects freshly signed mismatches and incomplete or contradictory authority", async () => {
    const body = await payload();
    const changes = [
      { viewer: relay },
      { community_id: entries[0].id },
      { host: "alias.test:9443" },
      { request_id: "cd".repeat(32) },
      { types: ["dm"] },
      { complete: false },
      { version: 2 },
      { extra: "authority" },
      { snapshot_id: "00".repeat(32) },
      { channels: [entries[0], entries[0]] },
      { channels: [...entries].reverse() },
      { channels: [{ ...entries[0], role: "superuser" }] },
      { channels: [{ ...entries[0], visibility: "hidden" }] },
      { channels: [{ ...entries[0], channel_type: "future" }] },
      { channels: [{ ...entries[0], archived: "false" }] },
      { channels: [{ ...entries[0], other_members: [viewer] }] },
    ];
    for (const change of changes)
      await expect(
        parseMembershipSnapshot(signed({ ...body, ...change }), binding),
      ).rejects.toThrow();
    // A response from another outstanding request cannot satisfy this one.
    await expect(
      parseMembershipSnapshot(signed(body), {
        ...binding,
        requestId: "ef".repeat(32),
      }),
    ).rejects.toThrow();
    await expect(
      parseMembershipSnapshot(signed(body), { ...binding, viewer: relay }),
    ).rejects.toThrow();
    await expect(
      parseMembershipSnapshot(signed(body), {
        ...binding,
        origin: "https://other.test",
      }),
    ).rejects.toThrow();
  });

  test("does not convert forged envelopes or transport errors into empty membership", async () => {
    const body = await payload();
    for (const event of [
      { kind: 39002 },
      {
        tags: [
          ["d", requestId],
          ["p", relay],
        ],
      },
      {
        tags: [
          ["d", requestId],
          ["p", viewer],
          ["p", viewer],
        ],
      },
    ])
      await expect(
        parseMembershipSnapshot(signed(body, event), binding),
      ).rejects.toThrow();
    const forged = signed(body);
    forged.event.sig = "00".repeat(64);
    await expect(parseMembershipSnapshot(forged, binding)).rejects.toThrow();
    await expect(
      parseMembershipSnapshot({}, binding),
    ).rejects.not.toBeInstanceOf(MembershipUnsupported);
    for (const array of [[], [signed(body).event]])
      await expect(
        parseMembershipSnapshot(array, binding),
      ).rejects.toBeInstanceOf(MembershipUnsupported);
    const small = {
      ...binding,
      capability: { ...binding.capability, max_channels: 1 },
    };
    await expect(
      parseMembershipSnapshot(signed(body), small),
    ).rejects.toThrow();
  });

  test("cancellation before verification or while hashing never returns authority", async () => {
    const raw = signed(await payload());
    const before = new AbortController();
    before.abort();
    await expect(
      parseMembershipSnapshot(raw, binding, before.signal),
    ).rejects.toThrow();
    const during = new AbortController();
    const pending = parseMembershipSnapshot(raw, binding, during.signal);
    during.abort();
    await expect(pending).rejects.toThrow();
  });

  test("bounds actual UTF-8 response bytes before parsing", async () => {
    await expect(membershipText(new Response("éé"), 3)).rejects.toThrow();
    expect(await membershipText(new Response("éé"), 4)).toBe("éé");
    const raw = signed(await payload());
    await expect(
      parseMembershipSnapshot(raw, {
        ...binding,
        capability: { ...binding.capability, max_response_bytes: 16 },
      }),
    ).rejects.toThrow();
  });
});

test("refreshes capability per generation and after explicit fallback, without hiding failures", async () => {
  const { readMembershipSnapshot } = await import("./membership-snapshot");
  let discoveries = 0;
  let info: unknown = { self: relay, membership_snapshot: descriptor };
  let result = {
    origin: binding.origin,
    signer_pubkey: viewer,
    request_id: requestId,
    status: 200,
    body: JSON.stringify(signed(await payload())),
  };
  const host = {
    origin: binding.origin,
    viewer,
    relay,
    async info() {
      discoveries++;
      return info;
    },
    async request() {
      return result;
    },
  };
  const signal = new AbortController().signal;
  await expect(
    readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
  ).resolves.toHaveProperty("channels", entries);
  info = { self: relay };
  await expect(
    readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
  ).rejects.toBeInstanceOf(MembershipUnsupported);
  info = { self: relay, membership_snapshot: descriptor };
  result = { ...result, body: "[]" };
  await expect(
    readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
  ).rejects.toBeInstanceOf(MembershipUnsupported);
  expect(discoveries).toBe(4);
  result = {
    ...result,
    status: 404,
    body: JSON.stringify({ error: "membership_snapshot unsupported" }),
  };
  await expect(
    readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
  ).rejects.toBeInstanceOf(MembershipUnsupported);
  expect(discoveries).toBe(6);
  result = {
    ...result,
    body: JSON.stringify({ error: "no community is configured for this host" }),
  };
  await expect(
    readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
  ).rejects.not.toBeInstanceOf(MembershipUnsupported);
  expect(discoveries).toBe(8);
  for (const change of [
    { signer_pubkey: relay },
    { origin: "https://other.test" },
    { request_id: "cc".repeat(32) },
  ]) {
    result = {
      origin: binding.origin,
      signer_pubkey: viewer,
      request_id: requestId,
      status: 200,
      body: JSON.stringify(signed(await payload())),
      ...change,
    };
    await expect(
      readMembershipSnapshot(host, MEMBERSHIP_TYPES, signal),
    ).rejects.toThrow();
  }
});
