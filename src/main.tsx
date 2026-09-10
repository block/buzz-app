// FOUNDATION: React startup. Keep initialization explicit and minimal.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServices } from "./app/services";
import { App } from "./app/App";
import "./shared/styles/globals.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error('Missing <div id="root"> in index.html');
}

const services = createServices();
const root = createRoot(container);
root.render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    void services.dispose().catch(console.error);
  });
}
