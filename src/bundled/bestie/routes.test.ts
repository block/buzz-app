import { expect, it } from "vitest";
import { bestieBaseTarget, bestieRoute, bestieThreadTarget } from "./routes";

const page = {
  version: 1,
  kind: "page",
  pluginId: "buzz.bestie",
  pageId: "bestie",
} as const;
const route = {
  messageId: "a".repeat(64),
  threadRootId: "b".repeat(64),
};

it("round-trips an exact Bestie thread route", () => {
  const target = bestieThreadTarget(page, route);
  expect(bestieRoute(target.route?.params)).toEqual(route);
  expect(bestieBaseTarget(target)).toEqual(page);
});

it.each([
  undefined,
  {},
  { messageId: route.messageId },
  { ...route, extra: true },
  { ...route, messageId: "not-an-event" },
  { ...route, threadRootId: "A".repeat(64) },
])("rejects an invalid Bestie thread route", (value) => {
  expect(bestieRoute(value)).toBeUndefined();
});
