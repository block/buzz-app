import { invoke, isTauri } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

export const inject = ["relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  let lease: Promise<string> | undefined;
  let scope: string | undefined;
  let viewer: string | undefined;
  let disposed = false;
  let selectionQueue: Promise<unknown> = Promise.resolve();
  const select = (community: string) => {
    const selected = selectionQueue
      .catch(() => {})
      .then(() => invoke<string>("mesh_compute_select", { community }));
    selectionQueue = selected;
    return selected;
  };
  const release = (old: Promise<string> | undefined) => {
    void old
      ?.then((lease) => invoke("mesh_compute_release", { lease }))
      .catch(() => {});
  };
  const sync = () => {
    const snapshot = ctx.relay.snapshot();
    const identityChanged = viewer !== undefined && snapshot.viewer !== viewer;
    if (snapshot.status !== "ready" && !identityChanged) return;
    if (identityChanged) {
      release(lease);
      lease = undefined;
      scope = undefined;
    }
    viewer = snapshot.viewer;
    const next =
      snapshot.status === "ready" &&
      snapshot.viewer &&
      snapshot.scope?.endsWith(`:${snapshot.viewer}`)
        ? snapshot.scope.slice(0, -(snapshot.viewer.length + 1))
        : undefined;
    if (next === scope) return;
    scope = next;
    const old = lease;
    lease = isTauri() && next ? select(next) : undefined;
    void lease?.catch(() => {});
    release(old);
  };
  sync();
  const unsubscribe = ctx.relay.subscribe(sync);
  ctx.effect(() => () => {
    disposed = true;
    unsubscribe();
    release(lease);
    lease = undefined;
  });

  function Settings() {
    const snapshot = useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const [status, setStatus] = useState("Not checked");
    const [busy, setBusy] = useState(false);
    const run = async (action: "start" | "stop" | "status") => {
      const selected = lease;
      setBusy(true);
      try {
        if (action === "start") {
          if (!selected) throw new Error("Connect to a community first");
          const id = await selected;
          if (disposed || selected !== lease)
            throw new Error("Community changed");
          await invoke("mesh_compute_start", { lease: id });
        } else if (action === "stop") {
          if (!selected) throw new Error("No Mesh selection");
          const id = await selected;
          if (disposed || selected !== lease)
            throw new Error("Community changed");
          await invoke("mesh_compute_release", { lease: id });
          // Stop revokes the old lease; reacquire only on the same still-active selection.
          if (!disposed && selected === lease && scope) {
            lease = select(scope);
            void lease.catch(() => {});
          }
        }
        const result = await invoke<unknown>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot())
          setStatus(JSON.stringify(result));
      } catch (error) {
        if (!disposed) setStatus(String(error));
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    return (
      <section>
        <p>
          Use compute shared by members of this community. Your prompts run on
          their machines.
        </p>
        <p>This preview uses shared compute; it does not share your machine.</p>
        <p>{!isTauri() && "Open Buzz desktop to connect to shared compute."}</p>
        <button
          type="button"
          disabled={busy || !isTauri() || snapshot.status !== "ready"}
          onClick={() => void run("start")}
        >
          Start Mesh client
        </button>
        <button
          type="button"
          disabled={busy || !isTauri()}
          onClick={() => void run("stop")}
        >
          Stop
        </button>
        <button
          type="button"
          disabled={busy || !isTauri()}
          onClick={() => void run("status")}
        >
          Refresh status
        </button>
        <output aria-live="polite">{status}</output>
      </section>
    );
  }
  ctx.settingsCards.register({
    id: "mesh",
    title: "Mesh compute",
    group: "Compute",
    component: Settings,
  });
};
