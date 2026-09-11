// FOUNDATION: React startup. Keep initialization explicit and minimal.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServices } from "./app/services";
import { App } from "./app/App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "./shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "./shared/design-system/useKeyboardFocusVisibility";

const container = document.getElementById("root");

if (!container) {
  throw new Error('Missing <div id="root"> in index.html');
}

const services = createServices();
const root = createRoot(container);
function HostApp() {
  useKeyboardFocusVisibility();
  return <App services={services} />;
}
root.render(
  <StrictMode>
    <HostApp />
  </StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    void services.dispose().catch(console.error);
  });
}
