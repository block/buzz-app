import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A companion page paints the saved appearance before its first frame, as the
// main window does, so a dark window never flashes light while it loads.
it.each(["popout.html", "huddle.html"])(
  "%s bootstraps the appearance and startup styles before its entry module",
  (page) => {
    const html = readFileSync(page, "utf8");
    const init = html.indexOf('<script src="/appearance-init.js"></script>');
    const styles = html.indexOf(
      '<link rel="stylesheet" href="/src/app/startup.css" />',
    );
    const entry = html.indexOf('<script type="module"');
    expect(init).toBeGreaterThan(-1);
    expect(styles).toBeGreaterThan(init);
    expect(entry).toBeGreaterThan(styles);
  },
);
