// Installed fixture code only; app composition, manager, contributions and UI remain production.
import * as shortcutCounter from "../../examples/plugins/shortcut-counter/plugin.js";
import shortcutManifest from "../../examples/plugins/shortcut-counter/manifest.json";
import { useEffect, useState } from "react";
import type { BundledPlugin } from "../../src/plugins/manager";
import type { PanelProps } from "../../src/features/panels/service";

declare global {
  interface Window {
    stalePanelClose?: () => void;
  }
}
function Notes({ close, target }: PanelProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    window.stalePanelClose = close;
  }, [close]);
  return (
    <label>
      Panel note ({target})
      <input
        aria-label="Panel note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function Legacy() {
  const [text, setText] = useState("");
  return (
    <label>
      Legacy page draft
      <input
        aria-label="Legacy page draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
export const fixturePlugins: readonly BundledPlugin[] = [
  { manifest: { ...shortcutManifest, apiVersion: 1 }, module: shortcutCounter },
  {
    manifest: { id: "fixture.notes", name: "Notes fixture", apiVersion: 1 },
    module: {
      inject: ["panels", "pages"],
      apply(ctx) {
        // Registered first on purpose: a global resolve(target) launcher bug must hit this instead.
        ctx.panels.register({
          id: "catch-all",
          title: "Wrong panel",
          matches: () => true,
          component: () => <p>Wrong match</p>,
        });
        ctx.panels.register({
          id: "notes",
          title: "Notes",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "not-an-agent-api" },
          component: Notes,
        });
        ctx.pages.register({
          id: "legacy",
          title: "Legacy",
          component: Legacy,
        });
      },
    },
  },
];
