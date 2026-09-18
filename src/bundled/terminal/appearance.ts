import type { ITheme } from "@xterm/xterm";

/** Translate the host's live CSS roles for xterm's non-CSS renderer. */
export function terminalAppearance(element: HTMLElement) {
  const css = getComputedStyle(element);
  const color = (role: string) => css.getPropertyValue(role).trim();
  const theme: ITheme = {
    background: color("--bg-panel"),
    foreground: color("--text-primary"),
    cursor: color("--text-primary"),
    cursorAccent: color("--bg-panel"),
    selectionBackground: color("--purple-3"),
    selectionForeground: color("--text-primary"),
    // Leave explicit ANSI colors to xterm's distinct palette: UI roles such as
    // --text-primary can coincide and make a CLI's foreground/background pair invisible.
  };
  return {
    theme,
    fontSize: Number.parseFloat(css.fontSize),
    fontFamily: css.fontFamily,
    lineHeight:
      Number.parseFloat(css.lineHeight) / Number.parseFloat(css.fontSize),
    letterSpacing: Number.parseFloat(css.letterSpacing) || 0,
  };
}
