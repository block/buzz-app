import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { Button } from "../../shared/design-system/ui/Button";
import { CpuIcon } from "../../shared/design-system/icons";
import { ShareModelPicker } from "./ShareModelPicker";
import { CommunityMesh } from "./CommunityMesh";
import { ConsumerComputeView } from "./ConsumerComputeView";

type MeshStatus = {
  available: boolean;
  // Configured intent, not proof of serving; lifecycle supplies the actual phase.
  sharing?: string | null;
  savedSharing?: { model: string; enabled: boolean } | null;
  settingsError?: string | null;
  download?: {
    label: string;
    file: string | null;
    downloadedBytes: number | null;
    totalBytes: number | null;
    done: boolean;
  } | null;
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
  const select = (community: string, restoreSharing = true) => {
    const selected = selectionQueue
      .catch(() => {})
      .then(() =>
        invoke<string>("mesh_compute_select", { community, restoreSharing }),
      );
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

  function CommunityComputePage({
    community,
  }: {
    community?: { id: string; name: string };
  }) {
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
        const selected = lease;
        void (selected ?? Promise.resolve())
          .then(() => invoke<MeshStatus>("mesh_compute_status"))
          .then(
            (result) => {
              if (active && snapshot === ctx.relay.snapshot())
                setStatus(result);
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
    const [model, setModel] = useState("");
    // biome-ignore lint/correctness/useExhaustiveDependencies: identity and community changes retire the prior model selection.
    useEffect(() => {
      setModel("");
    }, [snapshot.viewer, snapshot.scope]);
    useEffect(() => {
      if (status?.savedSharing?.model) setModel(status.savedSharing.model);
    }, [status?.savedSharing?.model]);
    const share = async (clearSaved = false) => {
      const selected = lease;
      setBusy(true);
      setError(null);
      try {
        if (!selected) throw new Error("Connect to a community first");
        const id = await selected;
        if (disposed || selected !== lease)
          throw new Error("Community changed");
        await invoke("mesh_compute_share", {
          lease: id,
          model: clearSaved || status?.sharing ? null : model,
          maxVramGb: null,
        });
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
      } catch (error) {
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setError(String(error));
          // Share Off may clear intent even when shutdown fails.
          const result = await invoke<MeshStatus>("mesh_compute_status").catch(
            () => null,
          );
          if (result && !disposed && snapshot === ctx.relay.snapshot())
            setStatus(result);
        }
      } finally {
        if (!disposed) setBusy(false);
      }
    };
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
          // Disconnect preserves the saved preference without immediately restoring it.
          if (!disposed && selected === lease && scope) {
            lease = select(scope, false);
            await lease;
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
        communityName={community?.name}
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
        error={
          error ??
          status?.lifecycle?.reason ??
          status?.settingsError ??
          status?.reason
        }
        refreshDisabled={busy || !isTauri()}
        connect={() => void run(enabled ? "stop" : "start")}
        refresh={() => void run("status")}
      >
        {isTauri() && status?.available && (
          <section aria-label="Share compute">
            <h2 className="text-body">Share your compute</h2>
            <p className="text-body-sm text-secondary">
              Community members’ prompts run on your hardware. Your selected
              model is visible to this community. Stop sharing stops this node,
              including agents using it; start an agent again to reconnect to
              another member’s compute. Buzz remembers one sharing configuration
              for its selected identity and community; sharing elsewhere
              replaces it. Disconnect also stops this shared node for now; saved
              sharing resumes when you reopen Buzz in this community. Use Stop
              sharing to keep it off.
            </p>
            <ShareModelPicker
              model={model}
              onChange={setModel}
              disabled={
                busy ||
                phase === "starting" ||
                phase === "stopping" ||
                Boolean(status.sharing)
              }
            />
            {phase === "starting" && status.download && (
              <p role="status">
                {status.download.done
                  ? "Download complete; loading model…"
                  : `Downloading ${status.download.file ?? status.download.label}`}
                {!status.download.done &&
                  status.download.downloadedBytes != null &&
                  ` · ${(status.download.downloadedBytes / 1e9).toFixed(2)} GB`}
                {!status.download.done &&
                  status.download.totalBytes != null &&
                  status.download.totalBytes > 0 &&
                  ` / ${(status.download.totalBytes / 1e9).toFixed(2)} GB`}
              </p>
            )}
            {!status.sharing && status.savedSharing && (
              <p className="text-body-sm text-secondary">
                {phase === "failed" ? "Sharing failed. " : ""}
                Saved model: {status.savedSharing.model}. Resume sharing to let
                Mesh verify the weights; missing assets may download.
                {phase === "failed" &&
                  " Restart Buzz before resuming if shutdown cannot be confirmed."}
              </p>
            )}
            {!status.sharing &&
              status.savedSharing?.enabled &&
              phase === "failed" && (
                <Button disabled={busy} onClick={() => void share(true)}>
                  Stop sharing
                </Button>
              )}
            {status.sharing && (
              <p role="status">
                {phase === "ready"
                  ? `Sharing ${status.sharing}`
                  : phase === "starting"
                    ? `Starting sharing ${status.sharing}…`
                    : phase === "failed"
                      ? `Sharing failed for ${status.sharing}. Stop sharing to clear the selection; restart Buzz if shutdown cannot be confirmed.`
                      : phase === "stopping"
                        ? `Stopping sharing ${status.sharing}…`
                        : `Selected for sharing: ${status.sharing}`}
              </p>
            )}
            <Button
              onClick={() => void share()}
              disabled={
                busy ||
                phase === "starting" ||
                phase === "stopping" ||
                snapshot.status !== "ready" ||
                (!status.sharing && !model.trim())
              }
            >
              {status.sharing
                ? "Stop sharing"
                : status.savedSharing?.model === model
                  ? "Resume sharing"
                  : "Share compute"}
            </Button>
          </section>
        )}
        {community && (
          <CommunityMesh
            key={community.id}
            community={community.id}
            relay={ctx.relay}
          />
        )}
      </ConsumerComputeView>
    );
  }
  ctx.settingsCards.register({
    id: "mesh",
    title: "Shared compute",
    icon: CpuIcon,
    component: CommunityComputePage,
  });
};
