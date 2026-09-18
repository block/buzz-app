import { buildTerminalBanner } from "./banner";
import styles from "./Terminal.module.css";

/** One bounded, non-interactive welcome per screen; shell output keeps flowing. */
export function createSplash(element: HTMLElement) {
  let consumed = false;
  let overlay: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    consumed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    overlay?.remove();
    overlay = undefined;
  };
  const layout = () => {
    if (!overlay) return;
    const art = document.createElement("pre");
    art.className = styles.splashArt ?? "";
    // The art has its own fixed glyph grid, not xterm's preference-scaled
    // line boxes. Measure that grid before deciding whether the wordmark fits.
    art.style.width = "1ch";
    art.style.height = "1.2em";
    overlay.replaceChildren(art);
    const cell = art.getBoundingClientRect();
    art.style.removeProperty("width");
    art.style.removeProperty("height");
    const columns = Math.min(Math.floor(element.clientWidth / cell.width), 160);
    // Keep enough decorative rows for the frame and honeycomb. In a shallow
    // drawer scale the artwork as a whole, rather than discarding the wordmark.
    const rows = Math.min(
      Math.max(Math.floor(element.clientHeight / cell.height), 24),
      48,
    );
    const banner = buildTerminalBanner(columns, rows, cell.height / cell.width);
    if (!banner) {
      const mark = document.createElement("span");
      mark.dataset.layer = "head";
      mark.textContent = "buzz term";
      mark.style.setProperty("--splash-hue", "280");
      art.append(mark);
    } else {
      // A font can fall back for block glyphs with different advances than spaces.
      // Place cells explicitly so one glyph's width cannot shift the rest of a row.
      art.classList.add(styles.splashGrid ?? "");
      art.style.gridTemplateColumns = `repeat(${banner.cells[0]?.length ?? 1}, 1ch)`;
      art.style.gridTemplateRows = `repeat(${banner.cells.length}, 1.2em)`;
      art.style.transform = `translate(-50%, -50%) scale(${Math.min(1, element.clientHeight / (rows * cell.height))})`;
      for (const [rowIndex, row] of banner.cells.entries()) {
        for (const [column, cell] of row.entries()) {
          if (!cell.layer || cell.char === " ") continue;
          const position =
            cell.layer === "head"
              ? cell.t
              : column / Math.max(1, row.length - 1);
          const glyph = document.createElement("span");
          glyph.dataset.layer = cell.layer;
          glyph.style.setProperty(
            "--splash-hue",
            String(Math.round(position * 24) * 12 + 15),
          );
          glyph.style.gridColumn = String(column + 1);
          glyph.style.gridRow = String(rowIndex + 1);
          glyph.textContent = cell.char;
          art.append(glyph);
        }
      }
    }
    overlay.replaceChildren(art);
  };
  return {
    show() {
      if (consumed || !element.isConnected || !element.clientHeight) return;
      consumed = true;
      overlay = document.createElement("div");
      overlay.className = styles.splash ?? "";
      overlay.dataset.terminalSplash = "";
      overlay.setAttribute("aria-hidden", "true");
      element.append(overlay);
      layout();
      timer = setTimeout(dismiss, 3000);
    },
    layout,
    dismiss,
  };
}
