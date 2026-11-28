import { expect, it } from "vitest";
import {
  adminReason,
  inviteListPath,
  inviteRequest,
  revokeRequest,
} from "./admin-protocol";

const id = "0b9c8f7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f";

it("mints either a bounded expiry or one that never expires", () => {
  expect(inviteRequest({ ttl_secs: 60, max_uses: 2, extra: 1 })).toEqual({
    ttl_secs: 60,
    max_uses: 2,
  });
  expect(inviteRequest({ never_expires: true })).toEqual({
    never_expires: true,
    max_uses: null,
  });
  for (const body of [
    { never_expires: true, ttl_secs: 60 },
    { never_expires: false, ttl_secs: 60 },
    { never_expires: "true" },
    {},
  ])
    expect(() => inviteRequest(body)).toThrow("Invalid invite expiry");
});

it("pages the invite list only by the relay's cursor", () => {
  expect(inviteListPath({})).toBe("/api/invites");
  expect(inviteListPath({ before: `1795049564000000_${id}` })).toBe(
    `/api/invites?before=1795049564000000_${id}`,
  );
  for (const body of [
    { before: "1&limit=200" },
    { before: `x_${id}` },
    { limit: 200 },
  ])
    expect(() => inviteListPath(body)).toThrow("Invalid invite list request");
});

it("revokes by exactly one of id or code", () => {
  expect(revokeRequest({ id })).toEqual({ id });
  expect(revokeRequest({ code: "v2.abc_-" })).toEqual({ code: "v2.abc_-" });
  for (const body of [
    {},
    { id, code: "v2.abc" },
    { id: "nope" },
    { code: "a b" },
    { code: "v2.abc", extra: 1 },
  ])
    expect(() => revokeRequest(body)).toThrow("Invalid revoke request");
});

it("shows only allowlisted relay refusals, never one carrying a code", () => {
  expect(adminReason({ error: "invite_not_found" })).toBe("invite_not_found");
  expect(adminReason({ error: "v2.leak not found" })).toBeUndefined();
});
