import type { ITheme } from "@xterm/xterm";

/** Translate the host's live CSS roles for xterm's non-CSS renderer. */
export function terminalAppearance(element: HTMLElement) {
  const css = getComputedStyle(element);
  const color = (role: string) => css.getPropertyValue(role).trim();
  const theme: ITheme = {
    background: color("--surface"),
    foreground: color("--text"),
    cursor: color("--text"),
    cursorAccent: color("--surface"),
    selectionBackground: color("--selected"),
    selectionForeground: color("--on-selected"),
    // Leave explicit ANSI colors to xterm's distinct palette: UI roles such as
    // --text can coincide and make a CLI's foreground/background pair invisible.
  };
  return {
    theme,
    fontSize: Number.parseFloat(css.fontSize),
    fontFamily: css.fontFamily,
  };
}
