// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  admitDeletion,
  type ApiFailure,
  checkDeletionStatus,
  clearPendingDeletion,
  DELETION_PENDING_KEY,
  persistPendingDeletion,
  readPendingDeletion,
  type DeletionRequest,
  type PendingDeletion,
} from "./api";

const request: DeletionRequest = {
  community_id: "11111111-1111-4111-8111-111111111111",
  host: "North.communities.buzz.xyz",
  request_id: "22222222-2222-4222-8222-222222222222",
  acknowledgement_version: 1,
};
const pending: PendingDeletion = {
  version: 1,
  owner_pubkey: "a".repeat(64),
  backend_origin: window.location.origin,
  request,
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
  await expect(admitDeletion(request, "fresh")).resolves.toMatchObject({
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
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it("terminates a fresh trustworthy structured pre-admission rejection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: { code: "must_archive" },
          correlation_id: "corr-must-archive",
        },
        { status: 409 },
      ),
    ),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "must_archive",
    correlationId: "corr-must-archive",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "broker string error",
    () => Response.json({ error: "upstream failed" }, { status: 502 }),
  ],
  ["malformed response", () => new Response("{", { status: 502 })],
  ["network response loss", () => Promise.reject(new TypeError("EOF"))],
])("keeps a fresh %s ambiguous", async (_label, firstResponse) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(firstResponse)
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "acceptance_unknown" } },
          { status: 503 },
        ),
      ),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps the same structured rejection uncertain during recovery", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { code: "must_archive" }, correlation_id: "corr-recovery" },
        { status: 409 },
      ),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "acceptance_unknown",
    correlationId: "corr-recovery",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("preserves receipt correlation when EOF is followed by relay_unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("EOF"))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: { code: "relay_unavailable" },
            correlation_id: "corr-receipt-relay",
          },
          { status: 503 },
        ),
      ),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
    correlationId: "corr-receipt-relay",
  } satisfies Partial<ApiFailure>);
});

it.each(["relay_unavailable", "not_owner"])(
  "treats retry admission %s as uncertain instead of proof of noncommit",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: { code }, correlation_id: `corr-admission-${code}` },
            { status: code === "not_owner" ? 403 : 503 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            {
              error: { code: "relay_unavailable" },
              correlation_id: `corr-receipt-${code}`,
            },
            { status: 503 },
          ),
        ),
    );
    await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
      code: "acceptance_unknown",
      correlationId: `corr-receipt-${code}`,
    } satisfies Partial<ApiFailure>);
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("does not accept an unbound aborted receipt as terminal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: { code: "deletion_aborted" },
          status: "aborted",
          correlation_id: "corr-unbound-abort",
        },
        { status: 409 },
      ),
    ),
  );
  await expect(checkDeletionStatus(request)).rejects.toMatchObject({
    code: "acceptance_unknown",
    correlationId: "corr-unbound-abort",
  } satisfies Partial<ApiFailure>);
});

it("accepts only a full tuple-bound aborted receipt as terminal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          ...request,
          error: { code: "deletion_aborted" },
          correlation_id: "corr-bound-abort",
        },
        { status: 409 },
      ),
    ),
  );
  await expect(checkDeletionStatus(request)).rejects.toMatchObject({
    code: "deletion_aborted",
    correlationId: "corr-bound-abort",
  } satisfies Partial<ApiFailure>);
});

it("requires HTTP 202 for a tuple-bound accepted result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...request, status: "accepted" }, { status: 200 }),
    ),
  );
  await expect(checkDeletionStatus(request)).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it("refuses to replace a different pending deletion", () => {
  persistPendingDeletion(pending);
  const replacement = {
    ...pending,
    request: {
      ...request,
      request_id: "33333333-3333-4333-8333-333333333333",
    },
  };
  expect(() => persistPendingDeletion(replacement)).toThrow(/already pending/i);
  expect(readPendingDeletion()).toEqual(pending);
});

it("does not clear a different pending envelope", () => {
  persistPendingDeletion(pending);
  clearPendingDeletion({
    ...pending,
    request: {
      ...pending.request,
      request_id: "33333333-3333-4333-8333-333333333333",
    },
  });
  expect(readPendingDeletion()).toEqual(pending);
});

it("requires the exact pending tuple to be readable after persistence", () => {
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  getItem.mockReturnValueOnce(null).mockReturnValueOnce(null);
  expect(() => persistPendingDeletion(pending)).toThrow(
    /could not be verified/i,
  );
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
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  });
});
