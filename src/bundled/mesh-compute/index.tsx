import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { ConsumerComputeView } from "./ConsumerComputeView";

type MeshStatus = {
  available: boolean;
  lifecycle?: {
    state: "stopped" | "starting" | "ready" | "stopping" | "failed";
    reason?: string;
  };
  reason?: string;
};
const phaseLabels = {
  stopped: "Off",
  starting: "Starting…",
  ready: "Running",
  stopping: "Stopping…",
  failed: "Needs attention",
};

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

  function CommunityComputePage() {
    const snapshot = useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const [status, setStatus] = useState<MeshStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      let active = true;
      setStatus(null);
      setError(null);
      if (isTauri()) {
        void invoke<MeshStatus>("mesh_compute_status").then(
          (result) => {
            if (active && snapshot === ctx.relay.snapshot()) setStatus(result);
          },
          (error) => {
            if (active && snapshot === ctx.relay.snapshot())
              setError(String(error));
          },
        );
      }
      return () => {
        active = false;
      };
    }, [snapshot]);
    const [busy, setBusy] = useState(false);
    const run = async (action: "start" | "stop" | "status") => {
      const selected = lease;
      setBusy(true);
      setError(null);
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
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
      } catch (error) {
        if (!disposed && snapshot === ctx.relay.snapshot())
          setError(String(error));
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    const phase = status?.lifecycle?.state;
    useEffect(() => {
      if (
        busy ||
        error ||
        (status?.lifecycle?.state !== "starting" &&
          status?.lifecycle?.state !== "stopping")
      )
        return;
      let active = true;
      const timer = setTimeout(() => {
        void invoke<MeshStatus>("mesh_compute_status").then(
          (result) => {
            if (active && !disposed && snapshot === ctx.relay.snapshot())
              setStatus(result);
          },
          (reason) => {
            if (active && !disposed && snapshot === ctx.relay.snapshot())
              setError(String(reason));
          },
        );
      }, 1000);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [status, busy, error, snapshot]);
    const enabled =
      phase === "starting" || phase === "ready" || phase === "stopping";
    return (
      <ConsumerComputeView
        active={enabled}
        starting={phase === "starting"}
        disabled={
          busy ||
          !isTauri() ||
          !status?.available ||
          !phase ||
          phase === "stopping" ||
          (!enabled && snapshot.status !== "ready")
        }
        status={
          !isTauri()
            ? "Open Buzz desktop to use shared compute."
            : phase
              ? phaseLabels[phase]
              : status?.available === false
                ? "Unavailable"
                : "Checking status…"
        }
        error={error ?? status?.lifecycle?.reason ?? status?.reason}
        refreshDisabled={busy || !isTauri()}
        connect={() => void run(enabled ? "stop" : "start")}
        refresh={() => void run("status")}
      />
    );
  }
  ctx.settingsCards.register({
    id: "mesh",
    title: "Compute",
    group: "Compute",
    component: CommunityComputePage,
  });
};
