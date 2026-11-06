import type { ITheme } from "@xterm/xterm";
import { type ColorScheme, xtermTheme } from "./theme-preference";

/** Translate the host's live CSS roles, or a chosen scheme, for xterm's non-CSS renderer. */
export function terminalAppearance(
  element: HTMLElement,
  scheme: ColorScheme | null = null,
) {
  const css = getComputedStyle(element);
  const color = (role: string) => css.getPropertyValue(role).trim();
  const theme: ITheme = scheme
    ? xtermTheme(scheme)
    : {
        background: color("--surface-panel"),
        foreground: color("--text-standard"),
        cursor: color("--text-standard"),
        cursorAccent: color("--surface-panel"),
        selectionBackground: color("--affordance-accent"),
        selectionForeground: color("--text-standard"),
        // Leave explicit ANSI colors to xterm's distinct palette: UI roles such as
        // --text-standard can coincide and make a CLI's foreground/background pair invisible.
      };
  return {
    theme,
    // A chosen scheme's colors render as its author designed them.
    minimumContrastRatio: scheme ? 1 : 4.5,
    fontSize: Number.parseFloat(css.fontSize),
    fontFamily: css.fontFamily,
    lineHeight:
      Number.parseFloat(css.lineHeight) / Number.parseFloat(css.fontSize),
    letterSpacing: Number.parseFloat(css.letterSpacing) || 0,
  };
}
