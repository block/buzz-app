import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  SECTION_ROW_CAP,
  SECTION_ROW_STEP,
  capSections,
} from "./sidebar-section-caps";

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `chat-${index}`,
  })) as unknown as ChannelSummary[];
const cap = (limit: number, kept: readonly string[] = []) =>
  capSections(
    [{ key: "solo", rows: rows(20) }],
    { solo: limit },
    (id) => kept.includes(id),
    new Set(),
  )[0]?.cap;

it("counts the rows the next Show more reveals", () => {
  expect(cap(0)).toMatchObject({ hidden: 13, next: SECTION_ROW_STEP });
  expect(cap(SECTION_ROW_STEP)).toMatchObject({ hidden: 3, next: 3 });
  expect(cap(2 * SECTION_ROW_STEP)).toMatchObject({ hidden: 0, next: 0 });
});

it("leaves kept rows already listed past the cap out of the next step", () => {
  const kept = [`chat-${SECTION_ROW_CAP}`, "chat-19"];
  // chat-7 is listed already; chat-19 is listed but beyond the next step.
  expect(cap(0, kept)).toMatchObject({
    hidden: 11,
    next: SECTION_ROW_STEP - 1,
  });
  expect(cap(SECTION_ROW_STEP, kept)).toMatchObject({ hidden: 2, next: 2 });
});
