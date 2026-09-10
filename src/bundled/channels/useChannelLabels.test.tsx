import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useChannelLabels } from "./useChannelLabels";
import { useChannelList } from "../../features/relay/react";
import { createRelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";

// The probe renders no host elements, so this inert container is sufficient.
// React DOM itself runs effects and unmount; neither the hook nor its store
// is mocked. Real-browser interaction is a separate check.
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

it.each([
  { outcome: "found", loaded: true },
  { outcome: "missing", loaded: true },
  { outcome: "failed", loaded: true },
  { outcome: "found", loaded: false },
  { outcome: "found", loaded: false, hidden: true },
  { outcome: "found", loaded: false, archived: true },
])(
  "reloads surviving DM names after authoritative channel deletion clears profiles (%s)",
  async ({ outcome, loaded, hidden, archived }) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let incoming!: (
      events: readonly import("../../features/relay/events").RelayEvent[],
    ) => void;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const dm = roster(relay, "dm", [viewer.pubkey, alice.pubkey]);
    const dmMetadata = signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", "dm"], ["t", "dm"], ["hidden"]],
    });
    let labels: readonly ChannelSummary[] = [];
    function Probe() {
      const list = useChannelList(owner.session.channels);
      labels = useChannelLabels(list.channels, owner.session.profiles);
      return null;
    }
    const root = createRoot(container());
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        wire.next().respond([
          dm,
          roster(relay, "temporary", [viewer.pubkey]),
          dmMetadata,
          signed(relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", "temporary"],
              ["name", "Temporary"],
              ...(hidden ? [["hidden"]] : []),
              ...(archived ? [["archived", "true"]] : []),
            ],
          }),
        ]);
        await flush();
      });
      expect(labels.some((row) => row.id === "temporary")).toBe(
        !hidden && !archived,
      );
      expect(wire.pending).toHaveLength(1);
      expect(wire.pending[0]?.filters).toEqual([
        { kinds: [0], authors: [alice.pubkey], limit: 500 },
      ]);
      const initial = wire.next();
      if (loaded) {
        await act(async () => {
          initial.respond([profile(alice, { display_name: "Alice" })]);
          await flush();
        });
        expect(labels.find((row) => row.id === "dm")?.name).toBe("Alice");
      }
      expect(wire.pending).toHaveLength(0);
      // Exercise the actual complete-roster omission -> session purge. Do not
      // clear the directory directly or remount the hook to prepare away the bug.
      await act(async () => {
        owner.session.channels.refreshList?.();
        wire.next().respond([dm, dmMetadata]);
        await flush();
      });
      if (!loaded) {
        expect(initial.signal?.aborted).toBe(true);
        await act(async () => {
          initial.respond([profile(alice, { display_name: "Stale" })]);
          await flush();
        });
      }
      expect(labels.map((row) => row.id)).toEqual(["dm"]);
      expect(owner.session.profiles.snapshot().has(alice.pubkey)).toBe(false);
      expect(labels[0]?.name).toBe(alice.pubkey.slice(0, 10));
      expect(wire.pending).toHaveLength(1);
      expect(wire.pending[0]?.filters).toEqual([
        { kinds: [0], authors: [alice.pubkey], limit: 500 },
      ]);
      await act(async () => {
        const read = wire.next();
        if (outcome === "failed") read.fail(new Error("offline"));
        else
          read.respond(
            outcome === "found"
              ? [profile(alice, { display_name: "Alice fresh" }, 1_700_000_001)]
              : [],
          );
        await flush();
      });
      expect(labels[0]?.name).toBe(
        outcome === "found" ? "Alice fresh" : alice.pubkey.slice(0, 10),
      );
      // Unrelated renders and empty/failed results must not cause a request loop.
      await act(async () => {
        incoming([message(viewer, "dm", "ordinary traffic", 1_700_000_002)]);
        await flush();
        root.render(createElement(Probe));
      });
      expect(wire.pending).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      owner.dispose();
    }
  },
);
