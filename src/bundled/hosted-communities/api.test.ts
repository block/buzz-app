// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  admitDeletion,
  type ApiFailure,
  DELETION_PENDING_KEY,
  readPendingDeletion,
  type DeletionRequest,
} from "./api";

const request: DeletionRequest = {
  community_id: "11111111-1111-4111-8111-111111111111",
  host: "North.communities.buzz.xyz",
  request_id: "22222222-2222-4222-8222-222222222222",
  acknowledgement_version: 1,
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["invalid JSON", "{"],
  [
    "extra public field",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: { ...request, owner_pubkey: "a".repeat(64) },
    }),
  ],
  [
    "noncanonical UUID",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: {
        ...request,
        request_id: "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase(),
      },
    }),
  ],
  [
    "different acknowledgement",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: { ...request, acknowledgement_version: 2 },
    }),
  ],
])("discards a stored envelope with %s", (_label, raw) => {
  localStorage.setItem(DELETION_PENDING_KEY, raw);
  expect(readPendingDeletion()).toBeNull();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
});

it("reconciles a mismatched admission response and validates the entire receipt tuple", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/delete")
        ? Response.json(
            { ...request, community_id: "wrong", status: "accepted" },
            { status: 202 },
          )
        : Response.json({ ...request, status: "accepted" }, { status: 202 });
    }),
  );
  await expect(admitDeletion(request)).resolves.toMatchObject({
    request_id: request.request_id,
    community_id: request.community_id,
  });
  expect(calls).toEqual([
    "/api/builderlab/delete",
    "/api/builderlab/delete-receipt",
  ]);
});

it("turns a missing receipt after ambiguous dispatch into acceptance_unknown", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("EOF"))
      .mockResolvedValueOnce(
        Response.json({ error: { code: "not_owner" } }, { status: 404 }),
      ),
  );
  await expect(admitDeletion(request)).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it.each([
  ["request_id", "33333333-3333-4333-8333-333333333333"],
  ["community_id", "wrong-community"],
  ["host", "north.communities.buzz.xyz"],
  ["acknowledgement_version", 2],
  ["status", "aborted"],
])("rejects a receipt with mismatched %s", async (field, value) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("EOF"))
      .mockResolvedValueOnce(
        Response.json(
          { ...request, status: "accepted", [field]: value },
          { status: 202 },
        ),
      ),
  );
  await expect(admitDeletion(request)).rejects.toMatchObject({
    code: "acceptance_unknown",
  });
});
