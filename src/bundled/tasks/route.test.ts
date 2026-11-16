import { expect, it } from "vitest";
import { taskLink, taskLinkId, taskRoute } from "./route";

const id = "11111111-1111-4111-8111-111111111111";

it("round-trips a task link and refuses anything else", () => {
  expect(taskLinkId(taskLink(id))).toBe(id);
  expect(taskLinkId(`buzz://plugin?id=buzz.tasks&route.task=nope`)).toBeNull();
  expect(taskLinkId(`buzz://plugin?id=buzz.other&route.task=${id}`)).toBeNull();
  expect(
    taskLinkId(`buzz://plugin?id=buzz.tasks&route.task=${id}&page=x`),
  ).toBeNull();
  expect(taskLinkId(`https://example.org/?route.task=${id}`)).toBeNull();
  expect(taskRoute({ task: id })).toBe(id);
  expect(taskRoute({ task: id, more: "x" })).toBeUndefined();
  expect(taskRoute([id])).toBeUndefined();
});
