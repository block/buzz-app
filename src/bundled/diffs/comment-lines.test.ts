import { expect, it } from "vitest";
import {
  commentLines,
  commentLineForView,
  commentableLine,
  type DiffLine,
} from "./comment-lines";
import { parsePatch } from "./parse";

it.each(["unified", "split"] as const)(
  "chooses valid comment coordinates in %s",
  (layout) => {
    const old: DiffLine = { side: "deletions", lineNumber: 8 };
    const next: DiffLine = { side: "additions", lineNumber: 9 };
    expect(commentLineForView([old, next], "deletions", layout)).toEqual(
      layout === "unified" ? next : old,
    );
    expect(commentLineForView([old, next], "additions", layout)).toEqual(next);
    expect(commentLineForView([old], "deletions", layout)).toEqual(old);
    expect(commentLineForView([next], "additions", layout)).toEqual(next);
    expect(commentLineForView([], "additions", layout)).toBeUndefined();
  },
);

it("preserves both context coordinates after insertions in a renamed file", () => {
  const files = parsePatch(`diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -5000,2 +5000,3 @@
-old
+new
+inserted
 context
`);
  expect(files).toHaveLength(1);
  const file = files?.[0];
  if (!file) throw new Error("Missing parsed fixture");
  expect(commentableLine(file, { side: "deletions", lineNumber: 4999 })).toBe(
    false,
  );
  expect(commentableLine(file, { side: "additions", lineNumber: 4999 })).toBe(
    false,
  );
  expect(commentableLine(file, { side: "deletions", lineNumber: 5001 })).toBe(
    true,
  );
  expect(commentableLine(file, { side: "additions", lineNumber: 5002 })).toBe(
    true,
  );
  expect(commentableLine(file, { side: "deletions", lineNumber: 5002 })).toBe(
    false,
  );
  expect(commentLines(file)).toEqual([
    [{ side: "deletions", lineNumber: 5000 }],
    [{ side: "additions", lineNumber: 5000 }],
    [{ side: "additions", lineNumber: 5001 }],
    [
      { side: "deletions", lineNumber: 5001 },
      { side: "additions", lineNumber: 5002 },
    ],
  ]);
});
