import "../../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import { createRoot } from "react-dom/client";
import { Playground, type Appearance } from "./playground";
import { entries } from "./specimens";
import "./styles.css";

function appearance({ theme, textScale }: Appearance) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.colorMode = theme;
  document.documentElement.dataset.colorLevel = "touch";
  document.documentElement.dataset.accent = "blue";
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(textScale),
  );
}
appearance({ theme: "light", textScale: 1 });
const root = document.getElementById("root");
if (!root) throw new Error("Playground root missing");
createRoot(root).render(
  <Playground
    title="Voice & point"
    entries={entries}
    onAppearanceChange={appearance}
  />,
);
