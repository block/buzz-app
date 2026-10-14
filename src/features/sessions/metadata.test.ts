import { expect, it } from "vitest";
import {
  SESSION_CHANNEL_DESCRIPTION,
  sessionDescription,
  sessionMetadata,
} from "./metadata";

const parent = "22222222-2222-4222-8222-222222222222";

it("retains legacy markers and round-trips bounded naming evidence", () => {
  expect(sessionMetadata(sessionDescription())).toEqual({});
  expect(sessionMetadata(sessionDescription(parent))).toEqual({
    parentId: parent,
  });
  expect(sessionMetadata(sessionDescription(undefined, { personal: true }))).toEqual(
    { personal: true },
  );
  expect(
    sessionMetadata(sessionDescription(parent, { personal: true })),
  ).toEqual({ parentId: parent, personal: true });
  expect(sessionDescription(undefined, { personal: true })).toBe(
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal`,
  );
  for (const automatic of [
    "First prompt",
    "🙂".repeat(80),
    'A "quoted" prompt',
  ])
    for (const explicit of [false, true])
      expect(
        sessionMetadata(sessionDescription(undefined, { naming: { automatic, explicit } })),
      ).toEqual({ naming: { automatic, explicit } });
  expect(
    sessionMetadata(sessionDescription(undefined, { naming: { explicit: true } })),
  ).toEqual({ naming: { explicit: true } });
  expect(
    sessionMetadata(
      sessionDescription(parent, {
        personal: true,
        naming: { automatic: "First prompt", explicit: false },
      }),
    ),
  ).toEqual({
    parentId: parent,
    personal: true,
    naming: { automatic: "First prompt", explicit: false },
  });
});

it.each([
  '{"explicit":false}',
  '{"automatic":"","explicit":false}',
  '{"automatic":null,"explicit":true}',
  '{"automatic":"#name","explicit":true}',
  '{"automatic":"name ","explicit":false}',
  '{"automatic":"name","explicit":"true"}',
  '{"automatic":"name","explicit":true,"extra":1}',
  '{"explicit":true,"automatic":"name"}',
  '{"automatic":"name","automatic":"name","explicit":true}',
  JSON.stringify({ automatic: "a".repeat(81), explicit: true }),
])("rejects malformed or noncanonical naming evidence %s", (json) => {
  expect(
    sessionMetadata(`${sessionDescription()}\nnaming:${json}`),
  ).toBeUndefined();
});

it("rejects extra lines and malformed ancestry without changing legacy recognition", () => {
  for (const description of [
    undefined,
    "",
    "Buzz session (notes)",
    `${SESSION_CHANNEL_DESCRIPTION}\n`,
    `${SESSION_CHANNEL_DESCRIPTION}\nparent:`,
    `${SESSION_CHANNEL_DESCRIPTION}\nparent:not-a-uuid`,
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal\nparent:${parent}`,
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal\npersonal`,
    `${SESSION_CHANNEL_DESCRIPTION}\nPersonal`,
    `${SESSION_CHANNEL_DESCRIPTION}\nme`,
    ` ${SESSION_CHANNEL_DESCRIPTION}`,
  ])
    expect(sessionMetadata(description)).toBeUndefined();
  expect(
    sessionMetadata(`${sessionDescription()}\nnaming:{"explicit":true}\nextra`),
  ).toBeUndefined();
});
