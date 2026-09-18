// Native drag ghost: an always-on-top window Rust moves under the pointer while
// a tab is dragged. It renders the lifted tab from a spec the app window read
// off its live DOM (size, icon markup, resolved styles), so it matches the tab
// and the current theme exactly. The spec arrives in the query string on
// creation and via hashchange on reuse; this page needs no IPC.
const render = () => {
  const raw =
    new URLSearchParams(location.hash.slice(1)).get("spec") ||
    new URLSearchParams(location.search).get("spec");
  let spec;
  try {
    spec = raw ? JSON.parse(raw) : undefined;
  } catch {
    spec = undefined;
  }
  if (!spec || typeof spec !== "object") return;
  const text = (value) => (typeof value === "string" ? value : "");
  const tab = document.getElementById("tab");
  tab.style.width = `${Number(spec.width) || 0}px`;
  tab.style.height = `${Number(spec.height) || 0}px`;
  tab.style.background = text(spec.background);
  tab.style.color = text(spec.color);
  tab.style.font = text(spec.font);
  tab.style.padding = text(spec.padding);
  tab.style.gap = text(spec.gap);
  tab.style.borderRadius = text(spec.radius);
  const rims = text(spec.shadow);
  const lift = "0 6px 20px rgba(0, 0, 0, 0.28)";
  tab.style.boxShadow = rims && rims !== "none" ? `${rims}, ${lift}` : lift;
  for (const old of tab.querySelectorAll("svg, img")) old.remove();
  const icon = text(spec.icon);
  // Only the tab's own icon element is accepted: an <svg> or a same-origin <img>.
  if (/^<(svg|img)[\s>]/.test(icon)) {
    const parsed = new DOMParser().parseFromString(icon, "text/html").body
      .firstElementChild;
    if (
      parsed &&
      (parsed.tagName === "svg" ||
        (parsed.tagName === "IMG" &&
          parsed.getAttribute("src")?.startsWith("/")))
    ) {
      const size = text(spec.iconSize);
      if (size) {
        parsed.style.width = size;
        parsed.style.height = size;
      }
      tab.prepend(parsed);
    }
  }
  document.getElementById("title").textContent = text(spec.title);
};
window.addEventListener("hashchange", render);
render();
