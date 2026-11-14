import { describe, expect, it } from "vitest";
import { PublishRejected } from "./outbox";
import {
  failureText,
  NamedError,
  refusalKind,
  refusalReason,
  refusalSentence,
  retryable,
} from "./refusal";

describe("refusalKind", () => {
  it.each([
    ["restricted: insufficient scope", "permission"],
    ["blocked: not a member", "permission"],
    ["auth-required: sign in", "sign-in"],
    ["rate-limited: slow down", "busy"],
    ["duplicate: already have it", "duplicate"],
    ["conflict: stale head", "conflict"],
    ["invalid: bad tag", "invalid"],
    ["pow: difficulty 20", "invalid"],
    ["unsupported: kind", "invalid"],
    ["error: database", "error"],
    ["Retry blocked: restricted: no", "permission"],
    ["Retry failed: rate-limited: wait", "busy"],
  ] as const)("reads the NIP-01 prefix of %j", (reason, kind) => {
    expect(refusalKind(reason)).toBe(kind);
  });

  it.each([
    ["Relay rejected the message (401)", "sign-in"],
    ["Relay rejected the message (403)", "permission"],
    ["Relay rejected the message (409)", "conflict"],
    ["Relay rejected the message (429)", "busy"],
    ["Relay rejected the message (400)", "invalid"],
    ["Retry blocked: Relay rejected the message (403)", "permission"],
  ] as const)("reads the HTTP status of %j", (reason, kind) => {
    expect(refusalKind(reason)).toBe(kind);
  });

  it("reads an item's own relay words when its summary drops the prefix", () => {
    // transport.ts shows "blocked: not a member" as "Not a member".
    expect(
      refusalKind({ error: "Not a member", reason: "blocked: not a member" }),
    ).toBe("permission");
    expect(
      refusalKind({
        error: "Retry blocked: Insufficient scope",
        reason: "restricted: insufficient scope",
      }),
    ).toBe("permission");
    // Relay words without a prefix leave the HTTP summary to say what it was.
    expect(
      refusalKind({
        error: "Relay rejected the message (403)",
        reason: "not allowed",
      }),
    ).toBe("permission");
    expect(
      refusalSentence({
        error: "You are timed out until 1700000000",
        reason: "restricted: you are timed out until 1700000000",
      }),
    ).toMatch(/^You’re timed out until /);
  });

  it("knows nothing of other text", () => {
    expect(refusalKind(undefined)).toBeUndefined();
    expect(refusalKind("Network request failed")).toBeUndefined();
    // A summary alone can't say which prefix it lost.
    expect(refusalKind({ error: "Insufficient scope" })).toBeUndefined();
  });
});

describe("refusalReason", () => {
  it("puts a refusal in plain words that follow “Not sent:”", () => {
    expect(refusalReason("restricted: insufficient scope")).toBe(
      "you don’t have permission",
    );
    expect(refusalReason("Relay rejected the message (429)")).toBe(
      "the community asked Buzz to slow down",
    );
    expect(refusalReason("offline")).toBeUndefined();
  });

  it("names when a timeout ends", () => {
    const reason = refusalReason(
      "restricted: you are timed out until 1700000000",
    );
    expect(reason).toMatch(/^you’re timed out until /);
    expect(reason).not.toMatch(/restricted|1700000000/);
    expect(refusalReason("you are timed out until 1700000000")).toBe(reason);
  });
});

describe("refusalSentence", () => {
  it("makes the reason a sentence of its own", () => {
    expect(refusalSentence("blocked: no")).toBe("You don’t have permission.");
    expect(refusalSentence("Something else")).toBeUndefined();
  });
});

describe("failureText", () => {
  it("prefers the plain refusal, then the error's own words", () => {
    expect(failureText(new Error("restricted: nope"))).toBe(
      "You don’t have permission.",
    );
    expect(failureText(new Error("Couldn’t add Sam."))).toBe(
      "Couldn’t add Sam.",
    );
    expect(failureText("Error: Couldn’t add Sam.")).toBe("Couldn’t add Sam.");
    expect(failureText(undefined, "Try again.")).toBe("Try again.");
  });

  it("reads a thrown refusal's own relay words", () => {
    expect(
      failureText(new PublishRejected("Not a member", "blocked: not a member")),
    ).toBe("You don’t have permission.");
  });

  it("keeps a named failure as written", () => {
    const error = new NamedError(
      "Buzz couldn’t add Sam. Try adding them again.",
    );
    expect(error).toBeInstanceOf(Error);
    expect(failureText(error)).toBe(error.message);
  });
});

describe("retryable", () => {
  it("retries what can pass later, and nothing that fails the same way", () => {
    expect(retryable({})).toBe(true);
    expect(retryable({ unsent: "offline" })).toBe(true);
    expect(retryable({ unsent: "blocked" })).toBe(false);
    expect(retryable({ refused: true, error: "blocked: not a member" })).toBe(
      false,
    );
    expect(retryable({ refused: true, error: "Relay rejected it" })).toBe(
      false,
    );
    // A new sign-in, a wait or the community's own problem can clear.
    expect(
      retryable({
        refused: true,
        error: "Sign in again",
        reason: "auth-required: sign in again",
      }),
    ).toBe(true);
    expect(retryable({ refused: true, error: "error: storage down" })).toBe(
      true,
    );
    expect(
      retryable({ refused: true, error: "Relay rejected the message (429)" }),
    ).toBe(true);
  });
});
