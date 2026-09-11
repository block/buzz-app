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
  const layout = (columns: number, rows: number) => {
    if (!overlay) return;
    const banner = buildTerminalBanner(
      Math.min(columns, 160),
      Math.min(rows, 48),
      2,
    );
    const art = document.createElement("pre");
    art.className = styles.splashArt ?? "";
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
    show(columns: number, rows: number) {
      if (consumed || !element.isConnected || !element.clientHeight) return;
      consumed = true;
      overlay = document.createElement("div");
      overlay.className = styles.splash ?? "";
      overlay.dataset.terminalSplash = "";
      overlay.setAttribute("aria-hidden", "true");
      element.append(overlay);
      layout(columns, rows);
      timer = setTimeout(dismiss, 3000);
    },
    layout,
    dismiss,
  };
}
