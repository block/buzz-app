// Parser-blocking, same-origin bootstrap: no inline-script CSP exception required.
// Keep key/fallback aligned with shared/theme/service.ts (covered by service.test.ts).
(() => {
  let mode = "light";
  try {
    const preference = localStorage.getItem("buzz-appearance.v1");
    if (preference === "dark") mode = "dark";
    if (
      preference === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches
    )
      mode = "dark";
  } catch {
    // Storage may be denied; the built-in light palette still opens safely.
  }
  document.documentElement.dataset.colorMode = mode;
  let scale = 1;
  try {
    const value = Number(localStorage.getItem("buzz-font-scale.v1"));
    if (Number.isFinite(value) && value >= 0.8 && value <= 2)
      scale = Math.round(value * 10) / 10;
  } catch {
    /* Text remains readable when storage is unavailable. */
  }
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(scale),
  );
})();
