import { expect, it } from "vitest";
import {
  inboxRouteTarget,
  inboxTarget,
  isInboxRoute,
  routeOf,
  detailOf,
} from "./route";

it.each([
  {},
  { attention: "unread" },
  { attention: "all" },
  { activity: "all" },
  { activity: "channels" },
  { activity: "threads" },
  { activity: "mentions" },
  { activity: "dms" },
  { activity: "direct" },
  { activity: "working" },
  { activity: "waiting" },
  { compose: "new" },
  { activity: "all", attention: "unread" },
  { show: "archived" },
  { show: "inbox" },
  { sender: "humans" },
  { sender: "agents" },
  { sender: "everyone" },
  { activity: "dms", sender: "agents", show: "archived", attention: "unread" },
  { drafts: true },
  // buzz:// plugin links carry every route value as a string.
  { drafts: "true" },
])("accepts the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(true);
});

it.each([
  null,
  true,
  3,
  "threads",
  ["threads"],
  { attention: "read" },
  { activity: "drafts" },
  { activity: 1 },
  { activity: null },
  { show: "drafts" },
  { sender: "people" },
  { drafts: false },
  { drafts: "false" },
  { drafts: "" },
  // Drafts has no type, sender, status or attention filters to apply.
  { drafts: true, activity: "dms" },
  { drafts: true, show: "inbox" },
  { unknown: "x" },
  { compose: "other" },
  { compose: "new", channelId: "alpha" },
])("rejects the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(false);
});

it("reads a route only from a version 1 page target", () => {
  const params = { activity: "dms" } as const;
  expect(routeOf(inboxRouteTarget(params))).toEqual(params);
  expect(routeOf(inboxRouteTarget({ activity: "dms" }))).toEqual(params);
  expect(routeOf({ version: 1, kind: "home" })).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
    }),
  ).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 2, params },
    }),
  ).toBeUndefined();
  expect(routeOf(undefined)).toBeUndefined();
});

it("drops a link's retired Archived and Drafts choices", () => {
  const at = (params: Record<string, string | boolean>) =>
    routeOf({ ...inboxTarget, route: { version: 1, params } });
  expect(at({ show: "archived", sender: "agents" })).toEqual({
    sender: "agents",
  });
  expect(at({ show: "inbox" })).toEqual({});
  expect(at({ drafts: "true" })).toEqual({});
});

it("keeps the selected conversation in the address, separate from saved filters", () => {
  const target = inboxRouteTarget({
    activity: "threads",
    channelId: "room",
    threadId: "root",
    messageId: "reply",
  });
  expect(isInboxRoute(target.route.params)).toBe(true);
  expect(detailOf(target)).toEqual({
    channelId: "room",
    threadId: "root",
    messageId: "reply",
  });
  expect(routeOf(target)).toEqual({ activity: "threads" });
  expect(isInboxRoute({ threadId: "root" })).toBe(false);
  expect(isInboxRoute({ channelId: "" })).toBe(false);
});
