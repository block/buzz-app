import { createRoot } from "react-dom/client";
import "../../../src/shared/styles/globals.css";
import "../../../src/bundled/composer/lab/specimens.css";
import { ComposerStateGallery } from "../../../src/bundled/composer/lab/ComposerStateGallery";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";

function Catalogue() {
  useKeyboardFocusVisibility();
  return (
    <main className="product-page">
      <header className="product-page-header">
        <h1 className="text-title text-standard">Composer</h1>
        <p className="text-body text-subtle">
          The production composer with local preview data. Nothing is sent to a
          conversation.
        </p>
      </header>
      <ComposerStateGallery />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing catalogue root");
createRoot(root).render(<Catalogue />);
