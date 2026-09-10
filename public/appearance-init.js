// Parser-blocking, same-origin bootstrap: no inline-script CSP exception required.
// Keep key/fallback aligned with shared/theme/service.ts (covered by service.test.ts).
(() => {
  let mode = "light";
  try {
    if (localStorage.getItem("buzz-appearance.v1") === "dark") mode = "dark";
  } catch {
    // Storage may be denied; the built-in light palette still opens safely.
  }
  document.documentElement.dataset.colorMode = mode;
})();
