import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../shared/styles/globals.css";
import { BrowserControls } from "./BrowserControls";

const container = document.getElementById("browser-root");

if (!container) {
  throw new Error('Missing <div id="browser-root"> in browser.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserControls />
  </StrictMode>,
);
