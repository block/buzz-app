import { afterEach, expect, it, vi } from "vitest";
import { workspaceCanvas } from "../solo/workspace";
import { CANVAS_TIMEOUT_MS, NO_PROJECT, project, readProject } from "./project";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("hands over the whole Canvas, naming the folders it works in", () => {
  const canvas = workspaceCanvas({
    folders: ["~/app"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Use tokens.",
  });
  const { section, directories } = project(canvas);
  expect(directories).toEqual(["~/app", "~/trees"]);
  expect(section).toMatch(/^<workspace-canvas>\n/);
  expect(section).toContain("not your own workspace: `~/app`, `~/trees`.");
  expect(section).toContain(`${canvas.trim()}\n</workspace-canvas>`);
  expect(project("Just notes")).toEqual({
    section: expect.not.stringContaining("not your own workspace"),
    directories: [],
  });
  expect(project("  \n")).toBe(NO_PROJECT);
  expect(project(undefined)).toBe(NO_PROJECT);
});

it("reports an unread Canvas as unknown rather than empty", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await readProject(undefined)).toBe(NO_PROJECT);
  expect(
    await readProject(() => Promise.reject(new Error("offline"))),
  ).toBeUndefined();
  vi.useFakeTimers();
  const slow = readProject(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(CANVAS_TIMEOUT_MS);
  expect(await slow).toBeUndefined();
});
