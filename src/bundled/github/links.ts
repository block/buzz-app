// Whether github.com links in messages open in the browser instead of the
// side panel. Saved on this device and read on every link, so a change applies
// at once.
import { parseGitHubReference } from "./references";

export const BROWSER_LINKS_KEY = "buzz.github.open-links-in-browser";

export function opensInBrowser() {
  try {
    return localStorage.getItem(BROWSER_LINKS_KEY) === "true";
  } catch {
    return false;
  }
}

export const saveOpensInBrowser = (on: boolean) =>
  localStorage.setItem(BROWSER_LINKS_KEY, String(on));

/** The panel claims GitHub links unless they open in the browser. */
export const panelMatches = (target: string) =>
  !opensInBrowser() && !!parseGitHubReference(target);
