import { expect, test } from "vitest";
import type { SearchMessage } from "../../app/shell/useSearchMessages";
import {
  type DeviceMerge,
  mergedMessages,
  nextDeviceMerge,
} from "./device-merge";

const row = (id: string): SearchMessage => ({
  id,
  channelId: "crew",
  authorId: "a",
  createdAt: 1,
  preview: id,
  text: id,
  mentioned: { content: id, mentions: [] },
});
const rows = (...ids: string[]) => ids.map(row);
const ids = (messages: readonly SearchMessage[]) => messages.map((m) => m.id);
const all = () => true;

/** Feeds `steps` through the merge, as SearchResults does on each render. */
function run(
  steps: {
    key: string;
    device: string[];
    asked?: boolean;
    moved?: boolean;
    relay?: string[];
  }[],
) {
  let merge: DeviceMerge | undefined;
  return steps.map((step) => {
    merge = nextDeviceMerge(merge, {
      key: step.key,
      device: rows(...step.device),
      asked: !!step.asked,
      moved: !!step.moved,
    });
    return ids(mergedMessages(merge, rows(...(step.relay ?? [])), all));
  });
}

test("device rows follow each key until the relay is asked, then hold, with the relay's other rows below", () => {
  expect(
    run([
      { key: "dep", device: ["d1", "d2", "d3"] },
      { key: "depl", device: ["d2", "d3"] },
      // The index changes before the relay is asked: the rows follow it.
      { key: "depl", device: ["d4", "d2", "d3"] },
      // The relay's own hits reach the index as they arrive: they stay
      // with the relay's rows.
      {
        key: "depl",
        device: ["r1", "d4", "d2", "d3"],
        asked: true,
        relay: ["r1", "d2", "r2"],
      },
      // A message arriving afterwards doesn't move the rows above the relay's.
      {
        key: "depl",
        device: ["d5", "d4", "d2", "d3"],
        asked: true,
        relay: ["r1", "d2", "r2"],
      },
    ]),
  ).toEqual([
    ["d1", "d2", "d3"],
    ["d2", "d3"],
    ["d4", "d2", "d3"],
    ["d4", "d2", "d3", "r1", "r2"],
    ["d4", "d2", "d3", "r1", "r2"],
  ]);
});

test("moving through the list holds the device rows; the relay's still join below", () => {
  expect(
    run([
      { key: "q", device: ["d1", "d2"], moved: true },
      { key: "q", device: ["d3", "d1", "d2"], moved: true },
      {
        key: "q",
        device: ["d3", "d1", "d2"],
        moved: true,
        asked: true,
        relay: ["r1"],
      },
    ]),
  ).toEqual([
    ["d1", "d2"],
    ["d1", "d2"],
    ["d1", "d2", "r1"],
  ]);
});

test("a failed or slow relay leaves the device rows as they are", () => {
  // Slow: nothing waits for it. Failed: it answers with no rows.
  expect(
    run([
      { key: "q", device: ["d1", "d2"] },
      { key: "q", device: ["d1", "d2"] },
      { key: "q", device: ["d1", "d2"], asked: true },
    ]),
  ).toEqual([
    ["d1", "d2"],
    ["d1", "d2"],
    ["d1", "d2"],
  ]);
});

test("with no device rows, relay rows show as they arrive, and More messages adds below", () => {
  expect(
    run([
      { key: "q", device: [] },
      { key: "q", device: [], asked: true, relay: ["r1", "r2"] },
      { key: "q", device: [], asked: true, relay: ["r1", "r2", "r3"] },
    ]),
  ).toEqual([[], ["r1", "r2"], ["r1", "r2", "r3"]]);
});

test("a device row that can no longer be shown leaves, and its relay copy stays out", () => {
  const merge = nextDeviceMerge(undefined, {
    key: "q",
    device: rows("d1", "d2"),
    asked: true,
    moved: false,
  });
  expect(
    ids(mergedMessages(merge, rows("d1", "r1"), (m) => m.id !== "d1")),
  ).toEqual(["d2", "r1"]);
});
