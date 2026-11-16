import { expect, it } from "vitest";
import type { Task } from "./model";
import { accessChange, type Place, projectOf } from "./places";

const project = "00000000-0000-4000-8000-000000000001";
const mobile = "00000000-0000-4000-8000-000000000002";
const chat = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const loose = "00000000-0000-4000-8000-000000000005";

const places = new Map<string, Place>([
  [project, { id: project, name: "Buzz", kind: "channel" }],
  [mobile, { id: mobile, name: "mobile", kind: "channel", parent: project }],
  [chat, { id: chat, name: "Riley’s chat", kind: "chat", parent: project }],
  [other, { id: other, name: "Payments", kind: "channel" }],
  [loose, { id: loose, name: "random", kind: "channel" }],
]);
const task = (home: string) => ({ home }) as Task;

it("groups a task under the project its home is filed in", () => {
  expect(projectOf(task(mobile), places)).toEqual({
    id: project,
    name: "Buzz",
  });
  expect(projectOf(task(project), places)).toEqual({
    id: project,
    name: "Buzz",
  });
  expect(projectOf(task(loose), places)).toEqual({
    id: undefined,
    name: undefined,
  });
});

it("names the places whose people gain or lose access on a move", () => {
  // Within one project, only the filed place's own people change.
  expect(accessChange(mobile, chat, places)).toEqual({
    gain: [places.get(chat)],
    lose: [places.get(mobile)],
  });
  // Up to the project: the project's people already saw it.
  expect(accessChange(mobile, project, places)).toEqual({
    gain: [],
    lose: [places.get(mobile)],
  });
  expect(accessChange(mobile, other, places)).toEqual({
    gain: [places.get(other)],
    lose: [places.get(mobile), places.get(project)],
  });
});

it("never names a place the viewer can't read", () => {
  const hidden = "00000000-0000-4000-8000-000000000009";
  const filed = new Map(places).set(loose, {
    id: loose,
    name: "random",
    kind: "channel",
    parent: hidden,
  });
  expect(accessChange(mobile, loose, filed).gain).toEqual([filed.get(loose)]);
});
