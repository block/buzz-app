import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { compareRecent } from "./sidebar-sections";

const row = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({ id, name: id, ...extra });

it("orders by recency with deterministic inactive and tie fallbacks", () => {
  const roster = [
    row("z-id", { name: "same", lastActivityAt: 20 }),
    row("a-id", { name: "Same", lastActivityAt: 20 }),
    row("new", { name: "Zulu", lastActivityAt: 30 }),
    row("quiet-b", { name: "beta" }),
    row("quiet-a", { name: "Alpha" }),
  ];
  expect([...roster].sort(compareRecent).map(({ id }) => id)).toEqual([
    "new",
    "a-id",
    "z-id",
    "quiet-a",
    "quiet-b",
  ]);
});
