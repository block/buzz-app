import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useChannelList } from "./react";
import { createRelaySession } from "./session";
import { keypair, scriptedTransport } from "./testing";

// The probe renders no host elements, so this inert container is sufficient.
// React DOM itself runs effects, StrictMode replay and unmount; neither the
// hook nor its store is mocked. Real-browser interaction is a separate check.
function container() {
  const win = { HTMLIFrameElement: class {}, event: undefined };
  const doc = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
    defaultView: win,
    activeElement: null,
  };
  const node = {
    nodeType: 1,
    tagName: "DIV",
    nodeName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc,
    addEventListener() {},
    removeEventListener() {},
    textContent: "",
    firstChild: null,
  };
  Object.assign(doc, { documentElement: node, body: node });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return node as unknown as HTMLElement;
}
afterEach(() => vi.unstubAllGlobals());

for (const mode of ["offline", "pending", "prestarted"] as const) {
  const setup = () => {
    const relay = keypair(),
      viewer = keypair();
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession(
      mode === "offline" ? null : scripted.transport,
    );
    // provideRelay starts discovery before mounting the page in the real app.
    if (mode === "prestarted") owner.session.channels.ensureList();
    return { owner, scripted };
  };
  for (const command of ["ensureList", "refreshList"] as const) {
    it(`${mode}: ${command} preserves the public void runtime contract`, () => {
      const { owner } = setup();
      try {
        const invoke = owner.session.channels[command];
        if (!invoke) throw new Error(`Missing ${command} implementation`);
        expect(invoke()).toBeUndefined();
      } finally {
        owner.dispose();
      }
    });
  }
  for (const strict of [false, true]) {
    it(`${mode}: channel list ${strict ? "StrictMode replay" : "ordinary unmount"} has valid cleanup`, async () => {
      const { owner, scripted } = setup();
      let renders = 0;
      function Probe() {
        useChannelList(owner.session.channels);
        renders++;
        return null;
      }
      const errors: unknown[] = [];
      const warnings = vi
        .spyOn(console, "error")
        .mockImplementation((...args) => errors.push(args));
      const root = createRoot(container(), {
        onUncaughtError: (error) => errors.push(error),
      });
      try {
        await act(async () =>
          root.render(
            strict
              ? createElement(StrictMode, null, createElement(Probe))
              : createElement(Probe),
          ),
        );
        expect(renders).toBeGreaterThan(0);
        expect(scripted.pending).toHaveLength(mode === "offline" ? 0 : 1);
        await act(async () => root.unmount());
        expect(errors).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        warnings.mockRestore();
        owner.dispose();
      }
    });
  }
}
