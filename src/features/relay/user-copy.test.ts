import { describe, expect, it } from "vitest";
import { UploadError } from "./attachments";
import { isTransientFailure, ReadError } from "./errors";
import { ApiCapacity, ApiPaused } from "./http-admission";
import { PublishNotSent, PublishRejected } from "./outbox";
import { failureKind, refusalReason, userCopy } from "./user-copy";

const CONTEXT = "Couldn’t load messages.";
/** Raw shapes that must never reach `text`. */
const RAW =
  /ReadError|TypeError|DOMException|Error:|\(\d{3}\)|https?:|Relay |relay|network-|blocked:|restricted:|signal timed out|Failed to fetch/;

function expectClean(text: string) {
  expect(text).not.toMatch(RAW);
  expect(text.startsWith(CONTEXT)).toBe(true);
}

describe("userCopy", () => {
  it.each([
    [new ReadError("unavailable", "Relay read failed (503)", 503)],
    [new ReadError("unavailable", "Relay unreachable")],
    [new ReadError("unavailable", "Relay request failed (408)", 408)],
    // An edge proxy's 401/403 page in front of the relay clears on its own.
    [new ReadError("unavailable", "Relay request failed (401)", 401)],
    [new ReadError("unavailable", "Relay request failed (403)", 403)],
  ])("maps a transient ReadError to connection copy with retry", (error) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy).toEqual({
      text: `${CONTEXT} Check your connection, then try again.`,
      retry: true,
      kind: "connection",
      details: String(error),
    });
    expectClean(copy.text);
  });

  it.each([
    [new ReadError("invalid-response", "Relay response is not an event array")],
    [new ReadError("unavailable", "Relay request failed (400)", 400)],
    [new ReadError("unavailable", "Relay request failed (404)", 404)],
  ])("maps an unusable request or reply to no retry", (error) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy.kind).toBe("unusable");
    expect(copy.retry).toBe(false);
    expect(copy.text).toBe(CONTEXT);
    expect(copy.details).toContain("Relay");
    expectClean(copy.text);
  });

  it.each([
    [new ReadError("denied", "Relay read failed (403)", 403)],
    [new ReadError("denied", "Relay read failed (401)", 401)],
    [new ReadError("denied", "Conversation is unavailable")],
  ])("maps a denied read to refused without retry", (error) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy).toMatchObject({
      kind: "refused",
      retry: false,
      text: CONTEXT,
    });
  });

  it.each([
    [new ApiPaused(3000)],
    [new ApiCapacity()],
    [new ReadError("unavailable", "Query concurrency limit", 503)],
    [new ReadError("unavailable", "Live stream capacity reached")],
    [new ReadError("unavailable", "Too many", 429)],
    ["Query concurrency limit"],
  ])("maps paused and full queues to busy", (error) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy.kind).toBe("busy");
    expect(copy.retry).toBe(true);
    expect(copy.text).toBe(
      `${CONTEXT} Buzz is busy. Try again in a few seconds.`,
    );
    expectClean(copy.text);
  });

  it.each([
    [new ApiPaused(60_000)],
    // A relay's 60s quota hint, padded by a second (`apiFailure`).
    [new ApiPaused(61_000)],
    [new ReadError("unavailable", "Too many", 429, 5000)],
  ])("keeps a wait of a minute or less as a few seconds", (error) => {
    expect(userCopy(error, CONTEXT).text).toBe(
      `${CONTEXT} Buzz is busy. Try again in a few seconds.`,
    );
  });

  it.each([
    [new ApiPaused(61_001), "about 1 minute"],
    [new ApiPaused(89_999), "about 1 minute"],
    [new ApiPaused(90_000), "about 2 minutes"],
    // A relay's 300s hint, padded by a second.
    [new ApiPaused(301_000), "about 5 minutes"],
    [new ApiPaused(5 * 60_000), "about 5 minutes"],
    [
      new ReadError("unavailable", "Too many", 429, 59 * 60_000),
      "about 59 minutes",
    ],
    [new ApiPaused(60 * 60_000), "about 1 hour"],
    [new ApiPaused(3 * 60 * 60_000), "about 3 hours"],
  ])("names a long wait instead of a few seconds", (error, wait) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy).toMatchObject({
      kind: "busy",
      retry: true,
      text: `${CONTEXT} Buzz is busy. Try again in ${wait}.`,
    });
    expect(copy.text).not.toContain("a few seconds");
    expectClean(copy.text);
  });

  it("maps a cancelled read to the context sentence", () => {
    for (const error of [
      new ReadError("cancelled", "Relay read cancelled"),
      new DOMException("Relay session closed", "AbortError"),
    ])
      expect(userCopy(error, CONTEXT)).toMatchObject({
        kind: "cancelled",
        text: CONTEXT,
        retry: true,
      });
  });

  it("maps fetch's TypeError to connection copy, and retries it", () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "The network connection was lost.",
      "The Internet connection appears to be offline.",
      "NetworkError when attempting to fetch resource.",
      // A body read that loses the connection after the headers arrived.
      "network error",
      "Error in input stream",
    ]) {
      const error = new TypeError(message);
      const copy = userCopy(error, CONTEXT);
      expect(copy.kind).toBe("connection");
      expect(copy.retry).toBe(true);
      expect(copy.details).toBe(`TypeError: ${message}`);
      expectClean(copy.text);
      // Copy and automatic retry agree on what the network did.
      expect(isTransientFailure(error)).toBe(true);
    }
  });

  it("keeps any other TypeError unknown, not a network failure", () => {
    for (const error of [
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      new TypeError("x is not a function"),
    ]) {
      const copy = userCopy(error, CONTEXT);
      expect(copy).toMatchObject({
        kind: "unknown",
        retry: true,
        text: CONTEXT,
      });
      expect(copy.details).toBe(String(error));
      // A bug doesn't clear by reading again.
      expect(isTransientFailure(error)).toBe(false);
    }
  });

  it("maps DOMException names", () => {
    const timeout = userCopy(
      new DOMException("signal timed out", "TimeoutError"),
      CONTEXT,
    );
    expect(timeout).toMatchObject({
      kind: "timeout",
      retry: true,
      text: `${CONTEXT} It took too long. Try again.`,
    });
    expect(timeout.details).toContain("signal timed out");
    expectClean(timeout.text);
    expect(failureKind(new DOMException("offline", "NetworkError"))).toBe(
      "connection",
    );
    expect(
      userCopy(new DOMException("denied by user", "NotAllowedError"), CONTEXT),
    ).toMatchObject({ kind: "refused", retry: false, text: CONTEXT });
  });

  it.each([
    "Relay request could not be confirmed",
    "Relay response was interrupted",
    "Community discovery failed",
    "network-unavailable",
    "network-timeout",
  ])("maps the native transient string %s to connection copy", (raw) => {
    for (const error of [raw, new Error(raw)]) {
      const copy = userCopy(error, CONTEXT);
      expect(copy.kind).toBe("connection");
      expect(copy.retry).toBe(true);
      expect(copy.details).toContain(raw);
      expectClean(copy.text);
    }
  });

  it("keeps any other native string or Error only in details", () => {
    for (const error of [
      "Saved agent identities are malformed",
      new Error("Fixture close failed. Try End session again."),
      "Too many terminal sessions (maximum 20)",
    ]) {
      const copy = userCopy(error, CONTEXT);
      expect(copy).toMatchObject({
        kind: "unknown",
        retry: true,
        text: CONTEXT,
      });
      expect(copy.details).toContain(
        typeof error === "string" ? error : error.message,
      );
    }
  });

  it("has no details for an empty rejection", () => {
    expect(userCopy(undefined, CONTEXT)).toEqual({
      kind: "unknown",
      retry: true,
      text: CONTEXT,
    });
    expect(userCopy({ code: 7 }, CONTEXT).details).toBe('{"code":7}');
  });

  it("classifies a wrapper by its cause", () => {
    const error = new Error("Preference decode: x", {
      cause: new ReadError("invalid-response", "bad"),
    });
    expect(failureKind(error)).toBe("unusable");
  });

  it("keeps UploadError copy and its retry policy", () => {
    const failed = userCopy(new UploadError("failed"), CONTEXT);
    expect(failed).toMatchObject({
      text: "Upload did not finish. Retry or remove this file.",
      retry: true,
      kind: "connection",
    });
    expect(userCopy(new UploadError("size"), CONTEXT).retry).toBe(false);
    expect(userCopy(new UploadError("denied"), CONTEXT)).toMatchObject({
      text: "You don’t have permission to upload here.",
      retry: false,
    });
    expect(userCopy(new UploadError("capacity"), CONTEXT).kind).toBe("busy");
  });

  it("maps a relay refusal to its reason without the machine prefix", () => {
    const copy = userCopy(
      new PublishRejected(
        "You are not allowed to add members to this channel",
        "blocked: you are not allowed to add members to this channel",
      ),
      "Couldn’t add Sam.",
    );
    expect(copy).toEqual({
      text: "Couldn’t add Sam. You don’t have permission to add people to this channel.",
      retry: false,
      kind: "refused",
      details:
        "Error: You are not allowed to add members to this channel (blocked: you are not allowed to add members to this channel)",
    });
  });

  it("maps an unknown refusal to the context alone", () => {
    const copy = userCopy(
      new PublishRejected("invalid: event kind not allowed"),
      CONTEXT,
    );
    expect(copy).toMatchObject({
      text: CONTEXT,
      retry: false,
      kind: "refused",
    });
    expect(copy.details).toContain("invalid: event kind not allowed");
  });

  it("maps a publish that never left the device to connection copy", () => {
    expect(
      userCopy(new PublishNotSent("Relay API queue capacity reached"), CONTEXT),
    ).toMatchObject({ kind: "connection", retry: true });
    expect(
      userCopy(new PublishNotSent("rate-limited: slow down"), CONTEXT),
    ).toMatchObject({ kind: "busy", retry: true });
  });

  it.each([
    [
      new PublishNotSent("Relay requests paused; retry in 3s", undefined, {
        retryAfterMs: 3000,
      }),
      "a few seconds",
    ],
    [
      new PublishNotSent("Relay API queue capacity reached", undefined, {}),
      "a few seconds",
    ],
    [
      new PublishNotSent(
        "rate-limited: quota exceeded; retry in 300s",
        undefined,
        { retryAfterMs: 5 * 60_000 },
      ),
      "about 5 minutes",
    ],
  ])("reads a publish asked to wait as busy, with its wait", (error, wait) => {
    const copy = userCopy(error, CONTEXT);
    expect(copy).toMatchObject({
      kind: "busy",
      retry: true,
      text: `${CONTEXT} Buzz is busy. Try again in ${wait}.`,
    });
    expectClean(copy.text);
  });
});

describe("refusalReason", () => {
  it("formats a timeout's end", () => {
    const until = Math.floor(new Date(2026, 10, 6, 21, 20).getTime() / 1000);
    expect(refusalReason(`restricted: you are timed out until ${until}`)).toBe(
      "You’re timed out until Nov 6, 9:20 PM.",
    );
  });

  it("maps known community refusals", () => {
    expect(refusalReason("restricted: authorization denied")).toBe(
      "You don’t have permission to do this.",
    );
    expect(refusalReason("invalid: channel is archived")).toBe(
      "This channel is archived.",
    );
    expect(refusalReason("restricted: not a channel member")).toBe(
      "You’re not a member of this channel.",
    );
    expect(refusalReason("internal error")).toBeUndefined();
  });
});
