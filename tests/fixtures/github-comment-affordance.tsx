import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DiffViewer, type DiffLine } from "../../src/bundled/diffs/DiffViewer";
import { parsePatch } from "../../src/bundled/diffs/parse";
import { Button } from "../../src/shared/design-system/ui/Button";
import { fixturePatch } from "./github-comment-host";
import "../../src/shared/styles/globals.css";

// Simulate a renderer with expanded context beyond the verified GitHub patch.
const rendered = fixturePatch.replace(
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
        files={parsePatch(fixturePatch)}
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
