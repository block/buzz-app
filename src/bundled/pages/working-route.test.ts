import { expect, it } from "vitest";
import {
  parseOpenTarget,
  type JsonValue,
} from "../../features/navigation/targets";
import { workingRoute, workingTarget } from "./working-route";

const id = "11111111-1111-4111-8111-111111111111";
const channel = "22222222-2222-4222-8222-222222222222";
const target = {
  version: 1,
  kind: "page",
  pluginId: "com.squareup.pages",
  pageId: "pages",
} as const;
it("round-trips browser, editor, dialog, revision and new-draft addresses without content", () => {
  for (const value of [
    { view: "browse", query: "Research", trash: true },
    { view: "page", id, channel, edit: true, dialog: "link" },
    {
      view: "page",
      id,
      channel,
      dialog: "history",
      revision: "a".repeat(64),
      offset: 100,
    },
    { view: "new", draft: id },
  ]) {
    const route = workingRoute(value as JsonValue);
    expect(route).toEqual(value);
    if (!route) throw new Error("Missing route");
    expect(parseOpenTarget(workingTarget(target, route))).toMatchObject({
      route: { params: value },
    });
  }
  expect(
    workingRoute({
      view: "page",
      id,
      channel,
      edit: "true",
      community: "wss://notes.example.test",
    }),
  ).toEqual({
    view: "page",
    id,
    channel,
    edit: true,
    community: "https://notes.example.test",
  });
  expect(workingRoute({ id, channel })).toBeUndefined();
});
it.each([
  { view: "browse", query: "Plan", trash: true },
  { view: "page", id, channel, edit: true },
])("normalizes legacy Docs folder routes: %o", (route) => {
  expect(workingRoute({ ...route, folder: "shared" })).toEqual(route);
});
it.each([
  { author: "b".repeat(64), note: `30023:${"b".repeat(64)}:note` },
  { view: "browse", author: "b".repeat(64) },
  { view: "shared", shared: `30023:${"b".repeat(64)}:note` },
  { view: "profile", profile: "b".repeat(64) },
  { view: "page", id, channel, markdown: "private draft" },
  { view: "page", id, channel, revision: "a".repeat(64) },
  { view: "page", id, channel, dialog: "share", offset: 100 },
  { view: "new", draft: "bad" },
  { view: "browse", edit: true },
  { view: "browse", folder: "custom" },
  { view: "browse", query: "x".repeat(513) },
  { view: "page", id, channel, shared: `30023:${"b".repeat(64)}:note` },
])("rejects malformed or content-bearing presentation: %o", (value) => {
  expect(workingRoute(value)).toBeUndefined();
});
