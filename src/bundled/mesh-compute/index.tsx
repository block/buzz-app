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
      const selected = lease;
      setBusy(true);
      setError(null);
      try {
        if (!selected) throw new Error("Connect to a community first");
        const id = await selected;
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
        if (!disposed && snapshot === ctx.relay.snapshot())
          setError(String(reason));
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    const share = async (clearSaved = false) => {
      const selected = lease;
      setBusy(true);
      setError(null);
      try {
        if (!selected) throw new Error("Connect to a community first");
        const id = await selected;
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
    const run = async (action: "start" | "stop" | "status") => {
      const selected = lease;
      setBusy(true);
      setError(null);
      try {
        if (action === "start") {
          if (!selected) throw new Error("Connect to a community first");
          const id = await selected;
          if (!id) throw new Error("Mesh native runtime is unavailable");
          if (disposed || selected !== lease)
            throw new Error("Community changed");
          await invoke("mesh_compute_start", { lease: id });
        } else if (action === "stop") {
          if (!selected) throw new Error("No Mesh selection");
          const id = await selected;
          if (!id) throw new Error("Mesh native runtime is unavailable");
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
    const enabled =
      phase === "starting" || phase === "ready" || phase === "stopping";
    return (
      <ConsumerComputeView
        communityName={community?.name}
        active={enabled && !otherCommunity}
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
        connect={() => void run(enabled ? "stop" : "start")}
        refresh={() => void run("status")}
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
              checked={Boolean(status.sharing || status.savedSharing?.enabled)}
              disabled={
                busy ||
                phase === "starting" ||
                phase === "stopping" ||
                snapshot.status !== "ready" ||
                (!status.sharing &&
                  !status.savedSharing?.enabled &&
                  !auto &&
                  !model.trim())
              }
              onCheckedChange={(next) => {
                if (next) void share();
                else void share(!status.sharing);
              }}
            />
            <p aria-live="polite" className="text-body-sm">
              {shareStatus(status, phase, community?.name)}
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
  if (phase === "failed")
    return `Sharing failed${model ? ` for ${model}` : ""}. Turn sharing off to clear it; restart Buzz if shutdown cannot be confirmed.`;
  if (!model)
    return status.savedSharing?.enabled
      ? "Sharing is on but not running. Turn it off and on to retry."
      : "Sharing is off.";
  if (phase === "stopping")
    return status.finishingJoin
      ? "Stopping, finishing a peer connection…"
      : "Stopping sharing…";
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
