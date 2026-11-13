import { expect, it } from "vitest";
import { ReadError } from "../relay/errors";
import { ApiCapacity, ApiPaused } from "../relay/http-admission";
import { windowFailure } from "../relay/window-failure";
import { historyFailure } from "./history-failure";

const context = "Messages didn’t load.";

it.each([
  ["a 503", new ReadError("unavailable", "Relay read failed (503)", 503)],
  ["a native timeout", "network-timeout"],
  ["a native outage", "network-unavailable"],
  ["a cancelled read", new ReadError("cancelled", "Relay read cancelled")],
  ["an unknown failure", new Error("boom")],
  ["no failure", undefined],
])("keeps only the context and offers Try again for %s", (_, error) => {
  expect(historyFailure(error, context)).toMatchObject({
    text: context,
    retry: true,
    update: false,
  });
});

it.each([new ApiPaused(3000), new ApiCapacity()])(
  "tells the reader a busy Buzz can be tried again",
  (error) => {
    expect(historyFailure(error, context)).toMatchObject({
      text: `${context} Buzz is busy. Try again in a few seconds.`,
      retry: true,
      update: false,
    });
  },
);

it("offers only an update when the answer can never be used", () => {
  const failure = historyFailure(
    new ReadError("invalid-response", "Relay response is not an event array"),
    "Older messages didn’t load.",
  );
  // The surface's own sentence, as for any other failure; only the button differs.
  expect(failure).toMatchObject({
    text: "Older messages didn’t load.",
    retry: false,
    update: true,
  });
  // The raw text is for diagnostics, not the surface.
  expect(failure).not.toHaveProperty("details");
  expect(
    historyFailure(
      new ReadError("unavailable", "Relay read failed (400)", 400),
      context,
    ),
  ).toMatchObject({ text: context, retry: false, update: true });
});

it("offers neither button for a refusal and never shows the raw text", () => {
  const failure = historyFailure(
    new ReadError("denied", "Relay read failed (403)", 403),
    context,
  );
  expect(failure).toMatchObject({
    text: `${context} You don’t have access to this conversation.`,
    retry: false,
    update: false,
  });
  expect(failure.text).not.toMatch(/relay|403/i);
});

it("keeps a known refusal reason instead of the fallback", () => {
  expect(
    historyFailure(
      new ReadError("denied", "restricted: not a channel member", 403),
      context,
    ),
  ).toMatchObject({
    text: `${context} You’re not a member of this channel.`,
    retry: false,
  });
});

it("keeps a window failure non-empty, whatever rejected", () => {
  const error = new ReadError("unavailable", "down", 503);
  expect(windowFailure(error)).toBe(error);
  expect(windowFailure("network-timeout")).toBe("network-timeout");
  for (const value of ["", undefined, null, 0])
    expect(windowFailure(value)).toBeInstanceOf(Error);
});
