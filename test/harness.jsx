// A pretend host for the built plugin.js: two people in one channel, a relay
// that keeps the scene in memory, and the agent tools the plugin registered.
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as plugin from "./zz-canvas-plugin.js";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const people = { ["a".repeat(64)]: "Ada", ["b".repeat(64)]: "Ben", ["c".repeat(64)]: "Scout" };
const [ada, ben, agent] = Object.keys(people);

let head;
let count = 0;
const followers = new Set();
const publish = async (event) => {
  const prev = event.tags.find(([name]) => name === "prev")?.[1];
  if (prev !== head?.id) throw new Error("conflict: stale prev");
  head = { ...event, id: (++count).toString(16).padStart(64, "0") };
  for (const listener of [...followers]) listener([head]);
  return head;
};
const read = async () => (head ? [head] : []);

// With ?ui, the host offers its own controls, to this contract:
// src/features/plugin-ui/contract.ts in block/buzz-app.
const hostUi = new URLSearchParams(location.search).has("ui") && {
  Button: ({ children, variant, size, loading, ...props }) => (
    <button type="button" data-host="" {...props}>{children}</button>
  ),
  Input: ({ onValueChange, ...props }) => (
    <input data-host="" {...props} onChange={(event) => onValueChange?.(event.currentTarget.value)} />
  ),
  Menu: ({ items, icon, align, ...props }) => {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button type="button" data-host="" aria-label={props["aria-label"]} onClick={() => setOpen(!open)}>{icon}</button>
        {open && items.map((item) => (
          <button key={item.label} type="button" role="menuitem" onClick={() => (setOpen(false), item.onSelect())}>{item.label}</button>
        ))}
      </>
    );
  },
};

function host(viewer) {
  const seat = { tools: [], effects: [] };
  const session = {
    viewer,
    lifetimeSignal: new AbortController().signal,
    names: { subscribe: () => () => {}, snapshot: () => 0, resolve: (pubkey) => people[pubkey] },
    snapshotRead: read,
    configArtifactWriter: { sign: async (template) => template, publish: async (event) => Object.assign(event, await publish(event)) },
    artifacts: { follow: (_channels, listener) => (followers.add(listener), () => followers.delete(listener)) },
  };
  const snapshot = { status: "ready", viewer, scope: "test", generation: 1, session };
  plugin.apply({
    react: React,
    browser: { available: false, View: () => null },
    panels: { register: (panel) => (seat.panel = panel), requestOpen: () => true },
    relay: { subscribe: () => () => {}, snapshot: () => snapshot },
    agents: { addTool: (tool) => seat.tools.push(tool), addInstructions() {} },
    reflect: { get: (name) => (name === "ui" && hostUi) || undefined },
    effect: (start) => seat.effects.push(start()),
    provide() {},
  });
  return seat;
}
const seats = [host(ada), host(ben)];
window.canvasHarness = {
  inject: plugin.inject,
  async agent(name, args = {}) {
    const tool = seats[0].tools.find((candidate) => candidate.name === name);
    return JSON.parse(await tool.call({ pubkey: agent, query: read, publish }, { channel: CHANNEL }, args));
  },
};
createRoot(document.getElementById("root")).render(
  <main style={{ display: "flex", gap: 12, height: "100vh", padding: 12, boxSizing: "border-box" }}>
    {seats.map((seat, index) => (
      <section key={index} aria-label={`${index ? "Ben" : "Ada"}'s screen`} style={{ flex: 1, minWidth: 0, border: "1px solid #ddd", display: "flex", flexDirection: "column" }}>
        <seat.panel.component context={{ channelId: CHANNEL }} />
      </section>
    ))}
  </main>,
);
