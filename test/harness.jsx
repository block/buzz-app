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

// Stands in for the host's browser view: its own address bar, and a page that
// can go somewhere on its own. Like the host, it hands out a new function on
// every read of `View`, and keeps the address it was opened at.
const native = new URLSearchParams(location.search).has("native");
let opened = 0;
function NativeView({ url }) {
  const [at, setAt] = React.useState(url);
  const [draft, setDraft] = React.useState(url);
  React.useEffect(() => { opened += 1; }, []);
  const go = (next) => { setAt(next); setDraft(next); };
  return (
    <div data-native>
      <form onSubmit={(event) => { event.preventDefault(); go(draft); }}>
        <input aria-label="Address" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </form>
      <p data-page>{at}</p>
      <button type="button" onClick={() => go("https://pages.example/linked")}>A link in the page</button>
    </div>
  );
}

// Each seat is a pretend channel page: a strip of tabs, one per target the
// plugin asks to open, with every tab but the chosen one covered as the host
// covers them.
const TabName = React.createContext(undefined);
function host(viewer) {
  const seat = { tools: [], effects: [], open: () => false };
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
    browser: native ? { available: true, get View() { return (props) => <NativeView {...props} />; } } : { available: false, View: () => null },
    panels: {
      register: (panel) => (seat.panel = panel),
      requestOpen: ({ target }) => seat.panel.matches(target) && seat.open(target),
      useTabTitle(label) {
        const name = React.useContext(TabName);
        React.useLayoutEffect(() => (name?.(label), () => name?.(undefined)), [name, label]);
      },
    },
    relay: { subscribe: () => () => {}, snapshot: () => snapshot },
    agents: { addTool: (tool) => seat.tools.push(tool), addInstructions() {} },
    reflect: { get: (name) => (name === "ui" && hostUi) || undefined },
    effect: (start) => seat.effects.push(start()),
    provide() {},
  });
  return seat;
}
function Tab({ seat, target, chosen, close, setNames }) {
  const name = React.useCallback((label) => setNames((was) => ({ ...was, [target]: label })), [target, setNames]);
  return (
    <TabName.Provider value={name}>
      <div role="tabpanel" data-covered={chosen ? undefined : ""} style={{ display: chosen ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
        <seat.panel.component context={{ channelId: CHANNEL }} target={target} close={close} />
      </div>
    </TabName.Provider>
  );
}
function Seat({ seat, label }) {
  const [tabs, setTabs] = React.useState(["buzz-canvas:"]);
  const [chosen, setChosen] = React.useState("buzz-canvas:");
  const [names, setNames] = React.useState({});
  seat.open = (target) => {
    setTabs((was) => (was.includes(target) ? was : [...was, target]));
    setChosen(target);
    return true;
  };
  const close = (target) => {
    setTabs((was) => was.filter((other) => other !== target));
    setChosen((was) => (was === target ? "buzz-canvas:" : was));
  };
  return (
    <section aria-label={label} style={{ flex: 1, minWidth: 0, border: "1px solid #ddd", display: "flex", flexDirection: "column" }}>
      <div role="tablist" style={{ display: "flex", gap: 8, padding: 4, borderBottom: "1px solid #ddd" }}>
        {tabs.map((target) => (
          <button key={target} type="button" role="tab" aria-selected={target === chosen} style={{ fontWeight: target === chosen ? 700 : 400 }} onClick={() => setChosen(target)}>
            {names[target] ?? "Canvas"}
          </button>
        ))}
      </div>
      {tabs.map((target) => (
        <Tab key={target} seat={seat} target={target} chosen={target === chosen} close={() => close(target)} setNames={setNames} />
      ))}
    </section>
  );
}
const seats = [host(ada), host(ben)];
window.canvasHarness = {
  inject: plugin.inject,
  opened: () => opened,
  async agent(name, args = {}) {
    const tool = seats[0].tools.find((candidate) => candidate.name === name);
    return JSON.parse(await tool.call({ pubkey: agent, query: read, publish }, { channel: CHANNEL }, args));
  },
};
createRoot(document.getElementById("root")).render(
  <main style={{ display: "flex", gap: 12, height: "100vh", padding: 12, boxSizing: "border-box" }}>
    {seats.map((seat, index) => (
      <Seat key={index} seat={seat} label={`${index ? "Ben" : "Ada"}'s screen`} />
    ))}
  </main>,
);
