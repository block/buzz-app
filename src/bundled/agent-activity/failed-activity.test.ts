import { expect, it } from "vitest";
import { activityErrorText } from "./failed-activity";
it("bounds error prose without parsing HTML or arbitrary objects", () => {
  expect(activityErrorText({ error: "<img onerror=bad>" })).toBe(
    "<img onerror=bad>",
  );
  expect(
    activityErrorText({ error: { message: "Model request rejected" } }),
  ).toBe("Model request rejected");
  expect(activityErrorText({ error: {} })).toContain("See raw details");
  expect(activityErrorText({ error: "x".repeat(5000) })).toContain(
    "Error shortened",
  );
});
