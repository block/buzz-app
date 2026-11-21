import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DiffViewer, type DiffLine } from "../../src/bundled/diffs/DiffViewer";
import { parsePatch } from "../../src/bundled/diffs/parse";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const fixturePatch = `diff --git a/src/old.ts b/src/example.ts
similarity index 80%
rename from src/old.ts
rename to src/example.ts
--- a/src/old.ts
+++ b/src/example.ts
@@ -5000,2 +5000,3 @@
-const previous = true;
+const current = true;
+const inserted = true;
 export const context = true;
`;

// Simulate a renderer with expanded context beyond the verified GitHub patch.
const long = new URLSearchParams(location.search).has("long");
const source = long
  ? "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,120 +1,120 @@\n" +
    Array.from(
      { length: 120 },
      (_, line) => ` const value${line} = ${line};\n`,
    ).join("")
  : fixturePatch;
const rendered = source.replace(
  "@@ -5000,2 +5000,3 @@",
  "@@ -4999,3 +4999,4 @@\n outside verified patch",
);
function Fixture() {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [selected, setSelected] = useState<DiffLine[]>([]);
  return (
    <main>
      <Button
        onClick={() => setLayout(layout === "unified" ? "split" : "unified")}
      >
        Toggle layout
      </Button>
      <DiffViewer
        content={rendered}
        files={parsePatch(source)}
        viewType={layout}
        comments={{
          annotations: [],
          onSelect(_path, lines) {
            setSelected(lines);
          },
        }}
      />
      <output aria-label="Selected coordinates">
        {JSON.stringify(selected)}
      </output>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
