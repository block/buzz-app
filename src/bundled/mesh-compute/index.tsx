import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";

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

  function Settings() {
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
    const enabled =
      phase === "starting" || phase === "ready" || phase === "stopping";
    const message = error ?? status?.lifecycle?.reason ?? status?.reason;
    return (
      <section aria-label="Mesh compute">
        <SwitchPreferenceRow
          label="Use shared compute"
          description="Use compute shared by members of this community. Your prompts run on their machines."
          checked={enabled}
          disabled={
            busy ||
            !isTauri() ||
            !status?.available ||
            !phase ||
            phase === "stopping" ||
            (!enabled && snapshot.status !== "ready")
          }
          onCheckedChange={(checked) => void run(checked ? "start" : "stop")}
        />
        <PreferenceRow
          title="Status"
          subtitle={
            <span role="status">
              {!isTauri()
                ? "Open Buzz desktop to use shared compute."
                : phase
                  ? phaseLabels[phase]
                  : status?.available === false
                    ? "Unavailable"
                    : "Checking status…"}
            </span>
          }
          trailing={
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !isTauri()}
              onClick={() => void run("status")}
            >
              Refresh
            </Button>
          }
        />
        {message && (
          <p role="alert" className="text-body-sm text-danger">
            {message}
          </p>
        )}
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
