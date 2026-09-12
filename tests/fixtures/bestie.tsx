// Actual plugin and media client; the browser test supplies local relay/ACP fixtures.
import { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { apply } from "../../src/bundled/bestie";
import type { Panel } from "../../src/features/panels/service";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { createRelaySession } from "../../src/features/relay/session";
import "../../src/shared/styles/globals.css";

const viewer = import.meta.env.VITE_BESTIE_TEST_VIEWER;
const sessions = [createRelaySession(null), createRelaySession(null)] as const;
const listeners = new Set<() => void>();
let snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  viewer,
  scope: `https://alpha.example:${viewer}`,
  session: sessions[0].session,
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  async clearCache() {},
};
function select(other: boolean) {
  snapshot = {
    status: "ready",
    generation: 1,
    viewer,
    scope: `https://${other ? "beta" : "alpha"}.example:${viewer}`,
    session: sessions[other ? 1 : 0].session,
  };
  for (const listener of listeners) listener();
}
let panel: Panel | undefined;
const ctx = new Context();
ctx.provide("relay", relay);
ctx.provide("panels", {
  register(value: Panel) {
    panel = value;
  },
});
apply(ctx);
if (!panel) throw new Error("Bestie contribution missing");
const Content = panel.component;

function Fixture() {
  const [visible, setVisible] = useState(true);
  const [relocated, setRelocated] = useState(false);
  return (
    <main className="p-6">
      <nav className="mb-4 flex gap-4" aria-label="Fixture navigation">
        <button type="button" onClick={() => select(false)}>
          Select Alpha
        </button>
        <button type="button" onClick={() => select(true)}>
          Select Beta
        </button>
        <button type="button" onClick={() => setRelocated((value) => !value)}>
          Relocate Bestie
        </button>
        <button type="button" onClick={() => setVisible((value) => !value)}>
          {visible ? "Hide" : "Show"} Bestie
        </button>
      </nav>
      <div className="max-w-md">
        {visible &&
          (relocated ? (
            <aside key="sidebar">
              <Content target="" close={() => setVisible(false)} />
            </aside>
          ) : (
            <div key="dock">
              <Content target="" close={() => setVisible(false)} />
            </div>
          ))}
      </div>
    </main>
  );
}
window.addEventListener("pagehide", () => {
  void ctx.fiber.dispose();
  for (const session of sessions) session.dispose();
});
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(<Fixture />);
