import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { Button } from "../../shared/design-system/ui/Button";
import { Switch } from "../../shared/design-system/ui/Switch";
import { CpuIcon } from "../../shared/design-system/icons";
import { ShareModelPicker } from "./ShareModelPicker";
import { CommunityAgent } from "./CommunityAgent";
import { CommunityMesh } from "./CommunityMesh";
import { ConsumerComputeView } from "./ConsumerComputeView";

type MeshStatus = {
  available: boolean;
  modelReady?: boolean;
  finishingJoin?: boolean;
  boundCommunity?: string | null;
  // Configured intent, not proof of serving; lifecycle supplies the actual phase.
  sharing?: string | null;
  savedSharing?: { model: string; enabled: boolean; auto?: boolean } | null;
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

export const inject = ["relay", "settingsCards", "agentControl"];
export const apply: PluginModule["apply"] = (ctx) => {
  let lease: Promise<string | undefined> | undefined;
  let scope: string | undefined;
  let viewer: string | undefined;
  let disposed = false;
  let selectionQueue: Promise<unknown> = Promise.resolve();
  const select = (
    community: string,
    restoreSharing = true,
    replaceExisting = false,
  ) => {
    const selected = selectionQueue
      .catch(() => {})
      .then(async () => {
        const support = await invoke<MeshStatus>("mesh_compute_status");
        if (!support.available) return undefined;
        return invoke<string>("mesh_compute_select", {
          community,
          restoreSharing,
          ...(replaceExisting ? { replaceExisting: true } : {}),
        });
      });
    selectionQueue = selected;
    return selected;
  };
  const release = (old: Promise<string | undefined> | undefined) => {
    void old
      ?.then((lease) =>
        lease ? invoke("mesh_compute_release", { lease }) : undefined,
      )
      .catch(() => {});
  };
  // A rejected selection must not strand every later action behind a dead
  // promise: retry the current community once, then surface the real error.
  const currentLease = async () => {
    const selected = lease;
    if (!selected) throw new Error("Connect to a community first");
    try {
      return { selected, id: await selected };
    } catch (error) {
      if (!scope || selected !== lease) throw error;
      // Recovery for an action must never restore (start) saved sharing first.
      const retry = select(scope, false);
      lease = retry;
      return { selected: retry, id: await retry };
    }
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
    // Foreground navigation is not permission to move the app-owned compute.
    if (scope && next && !identityChanged) return;
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
        // A rejected selection still shows authoritative status and its error;
        // the next action retries the selection.
        void (selected ?? Promise.resolve())
          .catch((reason) => {
            if (active && snapshot === ctx.relay.snapshot())
              setError(String(reason));
          })
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
    // Controls wait for this community's selection instead of rejecting clicks.
    const [leaseReady, setLeaseReady] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: lease follows the relay snapshot.
    useEffect(() => {
      let active = true;
      const selected = lease;
      setLeaseReady(!selected);
      void selected?.then(
        (id) => {
          if (active) setLeaseReady(Boolean(id));
        },
        () => {
          // A rejected selection is retried by the next action.
          if (active) setLeaseReady(true);
        },
      );
      return () => {
        active = false;
      };
    }, [snapshot.viewer, snapshot.scope]);
    const [replaceConfirmed, setReplaceConfirmed] = useState(false);
    const viewedCommunity =
      snapshot.status === "ready" && snapshot.viewer && snapshot.scope
        ? snapshot.scope.slice(0, -(snapshot.viewer.length + 1))
        : undefined;
    const boundCommunity = status?.boundCommunity ?? scope;
    const otherCommunity = Boolean(
      viewedCommunity && boundCommunity && viewedCommunity !== boundCommunity,
    );
    const replace = async () => {
      if (!viewedCommunity || busy) return;
      setBusy(true);
      setError(null);
      const previousLease = lease;
      try {
        lease = select(viewedCommunity, false, true);
        await lease;
        scope = viewedCommunity;
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setStatus(await invoke<MeshStatus>("mesh_compute_status"));
          setReplaceConfirmed(false);
        }
      } catch (error) {
        lease = previousLease;
        setError(String(error));
      } finally {
        setBusy(false);
      }
    };
    const [model, setModel] = useState("");
    const [auto, setAuto] = useState(true);
    const [recommended, setRecommended] = useState<string | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: identity and community changes retire the prior model selection.
    useEffect(() => {
      setModel("");
      setAuto(true);
      setRecommended(null);
    }, [snapshot.viewer, snapshot.scope]);
    useEffect(() => {
      if (status?.savedSharing?.model) {
        setModel(status.savedSharing.model);
        setAuto(status.savedSharing.auto ?? false);
      }
    }, [status?.savedSharing?.model, status?.savedSharing?.auto]);
    const reset = async () => {
      setBusy(true);
      setError(null);
      try {
        const { selected, id } = await currentLease();
        if (!id) throw new Error("Mesh native runtime is unavailable");
        if (disposed || selected !== lease)
          throw new Error("Community changed");
        await invoke("mesh_compute_share", {
          lease: id,
          model: null,
          maxVramGb: null,
          auto: true,
          resetOnly: true,
        });
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setStatus(result);
          setAuto(true);
        }
      } catch (reason) {
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setError(String(reason));
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
    const share = async (clearSaved = false) => {
      setBusy(true);
      setError(null);
      try {
        const turningOff = clearSaved || Boolean(status?.sharing);
        let selected: Promise<string | undefined> | undefined;
        let id: string | undefined;
        try {
          ({ selected, id } = await currentLease());
        } catch (reason) {
          // Without a lease (e.g. an unrecovered failed runtime blocks selection),
          // Off still clears saved consent; it never starts or stops Mesh.
          if (!turningOff || !scope) throw reason;
          await invoke("mesh_compute_disarm", { community: scope });
          const result = await invoke<MeshStatus>("mesh_compute_status");
          if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
          return;
        }
        if (!id) throw new Error("Mesh native runtime is unavailable");
        if (disposed || selected !== lease)
          throw new Error("Community changed");
        await invoke("mesh_compute_share", {
          lease: id,
          model:
            clearSaved || status?.sharing
              ? null
              : auto
                ? (recommended ?? model)
                : model,
          maxVramGb: null,
          auto,
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
    const refresh = async () => {
      setBusy(true);
      setError(null);
      try {
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
    // Saved consent and live intent, not runtime health.
    const shareOn = Boolean(status?.sharing || status?.savedSharing?.enabled);
    useEffect(() => {
      if (
        busy ||
        error ||
        (status?.lifecycle?.state !== "starting" &&
          status?.lifecycle?.state !== "stopping" &&
          !(
            status?.lifecycle?.state === "ready" &&
            status.sharing &&
            !status.modelReady
          ))
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
    return (
      <ConsumerComputeView
        communityName={community?.name}
        status={
          !isTauri()
            ? "Open Buzz desktop to use shared compute."
            : phase
              ? phase === "ready" && status?.sharing && !status.modelReady
                ? "Preparing to share"
                : status?.finishingJoin
                  ? "Stopping, finishing a peer connection…"
                  : phaseLabels[phase]
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
        refresh={() => void refresh()}
      >
        {otherCommunity && (
          <section aria-label="Bound compute community">
            <p>
              {status?.sharing ? "Sharing" : "Compute connected"} in{" "}
              {boundCommunity}. Navigation does not move it.
            </p>
            {replaceConfirmed ? (
              <>
                <p>
                  Stop that community’s local Mesh agents and compute before
                  switching to {viewedCommunity}?
                </p>
                <Button disabled={busy} onClick={() => void replace()}>
                  Stop agents and switch compute
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setReplaceConfirmed(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => setReplaceConfirmed(true)}>
                Use compute in this community instead
              </Button>
            )}
          </section>
        )}
        {isTauri() && status?.available && !otherCommunity && (
          <section aria-label="Share compute">
            <h2 className="text-body">Share your compute</h2>
            <p className="text-body-sm text-secondary">
              Let {community?.name ?? "this community"} run prompts on this
              machine. Auto picks the best model for your hardware; Advanced
              lets you choose. Sharing resumes when you reopen Buzz.
            </p>
            <Switch
              label="Share this machine"
              checked={shareOn}
              disabled={
                busy ||
                !leaseReady ||
                phase === "starting" ||
                phase === "stopping" ||
                snapshot.status !== "ready" ||
                // Turning on: never replace an unrecovered failed runtime.
                (!shareOn && (phase === "failed" || (!auto && !model.trim())))
              }
              onCheckedChange={(next) => {
                if (next) void share();
                else void share(!status.sharing);
              }}
            />
            <p aria-live="polite" className="text-body-sm">
              {leaseReady
                ? shareStatus(status, phase, community?.name)
                : "Checking shared compute…"}
            </p>
            {status.sharing && status.download && !status.download.done && (
              <DownloadProgress download={status.download} />
            )}
            <ShareModelPicker
              model={model}
              auto={auto}
              onRecommendation={setRecommended}
              runningModel={status.sharing ?? null}
              onReset={() => void reset()}
              resetDisabled={busy || snapshot.status !== "ready"}
              onChange={(value) => {
                setModel(value);
                setAuto(false);
              }}
              disabled={
                busy ||
                phase === "starting" ||
                phase === "stopping" ||
                Boolean(status.sharing)
              }
            />
          </section>
        )}
        {community &&
          snapshot.viewer &&
          ctx.agentControl &&
          status?.available &&
          !otherCommunity && (
            <CommunityAgent
              key={`${community.id}:${snapshot.viewer}`}
              control={ctx.agentControl}
              destination={community.id}
              owner={snapshot.viewer}
            />
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

/** One status line in the style of the original Compute page. */
function shareStatus(
  status: MeshStatus,
  phase: string | undefined,
  communityName: string | undefined,
): string {
  const where = communityName ?? "your community";
  const model = status.sharing;
  const enabled = Boolean(model || status.savedSharing?.enabled);
  if (phase === "failed") {
    const cause = status.lifecycle?.reason
      ? ` ${status.lifecycle.reason}.`
      : "";
    return enabled
      ? `Mesh needs recovery.${cause} Sharing is still enabled for next launch; turn it off to disable automatic sharing. Restart Buzz before starting Mesh again.`
      : `Mesh needs recovery.${cause} Shutdown could not be confirmed. Restart Buzz before starting Mesh again.`;
  }
  if (phase === "stopping")
    return status.finishingJoin
      ? "Stopping, finishing a peer connection…"
      : "Stopping…";
  if (!model)
    return status.savedSharing?.enabled
      ? "Sharing is enabled but not running. Turn it off and on to start it again."
      : "Sharing is off.";
  if (phase === "starting") return `Starting ${model}…`;
  if (phase === "ready")
    return status.modelReady
      ? `Sharing ${model} with ${where}.`
      : `Preparing ${model} — not serving yet.`;
  return `Selected for sharing: ${model}`;
}

function DownloadProgress({
  download,
}: {
  download: NonNullable<MeshStatus["download"]>;
}) {
  const received = download.downloadedBytes ?? 0;
  const total = download.totalBytes ?? 0;
  const percent =
    total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined;
  return (
    <div>
      <progress
        aria-label="Model download"
        max={100}
        value={percent}
        className="w-full"
      />
      <span className="text-body-sm text-secondary">
        {`Downloading ${download.file ?? download.label}`}
        {percent === undefined
          ? "…"
          : ` · ${percent}% (${(received / 1e9).toFixed(2)} GB / ${(total / 1e9).toFixed(2)} GB)`}
      </span>
    </div>
  );
}
