import { expect, it } from "vitest";
import type { EventData } from "../relay/events";
import { eventBody, newestWithin, readEventBody } from "./turn-records";

const pubkey = "b".repeat(64);
const event = { id: "e".repeat(64), pubkey, kind: 9 } as EventData;

it("reads back the author and request of an event body, whatever the request holds", () => {
  // JSON leaves U+2028 and U+2029 as they are, so a record's line holds them.
  for (const request of [
    "plain <it>",
    "two\nlines",
    "line\u2028separator",
    "paragraph\u2029separator",
  ])
    expect(readEventBody(eventBody(event, request))).toEqual({
      pubkey,
      request,
    });
});

it("reads only a record that is one line", () => {
  const body = eventBody(event, "fix it");
  expect(readEventBody(body.replace("{", '{\n"x":1,'))).toBeUndefined();
  expect(readEventBody(`hi\n${body}`)).toBeUndefined();
});

it("keeps the newest records whose encoded cost fits the budget, in order", () => {
  // `"a"` re-encoded as a string is `"\"a\""`, 7 bytes.
  const records = ["a", "b", "c"];
  expect(newestWithin(records, 14)).toEqual(["b", "c"]);
  expect(newestWithin(records, 13)).toEqual(["c"]);
  expect(newestWithin(records, 6)).toEqual([]);
});
