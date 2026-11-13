// @vitest-environment node
import { expect, it } from "vitest";
import type { SessionUsage } from "./service";
import { withWakes } from "./session-usage";

const session = (id: string): SessionUsage => ({
  id,
  revision: `r-${id}`,
  gaps: [],
  startedAt: 1,
  lastAt: 2,
  observations: [],
});

it("fills in the wake of the sessions a harness saved one for", () => {
  expect(
    withWakes(
      [session("a"), session("b"), session("c")],
      [
        { id: "a", wake: "timer/daily" },
        { id: "b" },
        { id: "z", wake: "watch/gone" },
      ],
    ),
  ).toEqual([
    { ...session("a"), wake: "timer/daily" },
    session("b"),
    session("c"),
  ]);
});

it("returns the sessions as they are when none has a saved start", () => {
  const sessions = [session("a")];
  expect(withWakes(sessions, [])).toEqual(sessions);
});
