import { ownerReads } from "../../features/agents/reads";
import { InlineAgent } from "./inlineAgent";
import { createMeshTranscriptTab } from "./MeshTranscriptTab";
import { MemoryReads, coreOf } from "../../features/agent-harness/core-memory";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { Button } from "../../shared/design-system/ui/Button";
import { CpuIcon } from "../../shared/design-system/icons";
import { ComputeSettings } from "./ComputeSettings";

import { ComputeActivity, type ComputeActivityData } from "./ComputeActivity";
import { MeshAgentTab } from "./MeshAgentTab";
import { MeshHelpers } from "./MeshHelpers";
import { MeshCreateSetup } from "./MeshCreateSetup";
import {
  DEFAULT_MESH_AGENT_CONFIG,
  type MeshAgentConfig,
  MeshAgentRuntime,
  type PreparedInference,
} from "./meshAgent";

export type MeshStatus = {
  activity?: ComputeActivityData | null;
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
export const inject = [
  "relay",
  "settingsCards",
  "communityReader",
  "agents",
  "host",
];

// Settles when the most recent Share action has fully finished, so tests can
// prove a retired action completed instead of waiting an arbitrary tick.
let lastShareAction: Promise<void> = Promise.resolve();
export const shareActionSettled = () => lastShareAction;
// The native widget is one app window, including across plugin reloads.
let widgetQueue: Promise<unknown> = Promise.resolve();
export const apply: PluginModule["apply"] = (ctx) => {
  let lease: Promise<string | undefined> | undefined;
  let scope: string | undefined;
  let viewer: string | undefined;
  let disposed = false;
  const openWidget = () => {
    widgetQueue = widgetQueue
      .catch(() => {})
      .then(() => (disposed ? undefined : invoke("mesh_compute_widget_open")));
    return widgetQueue;
  };
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
    const account = ctx.communityReader.snapshot();
    const identityChanged = viewer !== undefined && account.viewer !== viewer;
    if (snapshot.status !== "ready" && !identityChanged) return;
    if (identityChanged) {
      release(lease);
      lease = undefined;
      scope = undefined;
    }
    viewer = account.viewer;
    const next =
      snapshot.status === "ready" &&
      snapshot.viewer === viewer &&
      snapshot.viewer &&
      snapshot.scope?.endsWith(`:${snapshot.viewer}`)
        ? snapshot.scope.slice(0, -(snapshot.viewer.length + 1))
        : undefined;
    // Foreground navigation is not permission to move the app-owned compute.
    if (scope && !identityChanged) return;
    if (next === scope) return;
    scope = next;
    const old = lease;
    lease = isTauri() && next ? select(next) : undefined;
    void lease?.catch(() => {});
    release(old);
  };
  sync();
  const unsubscribe = ctx.relay.subscribe(sync);
  const unsubscribeAccount = ctx.communityReader.subscribe(sync);
  ctx.effect(() => () => {
    disposed = true;
    unsubscribe();
    unsubscribeAccount();
    if (isTauri()) {
      widgetQueue = widgetQueue
        .catch(() => {})
        .then(() => invoke("mesh_compute_widget_close"))
        .catch(() => {});
    }
    release(lease);
    lease = undefined;
  });

  // Agents "Shared Compute" type: inference through shared compute only.
  const spawn = ctx.host?.spawn?.bind(ctx.host);
  if (isTauri() && spawn && ctx.agents) {
    const agents = ctx.agents;
    const memoryReads = new MemoryReads();
    const readMemory = async (agent: string, signal: AbortSignal) => {
      const snapshot = agents.relay(agent)?.snapshot();
      if (snapshot?.status !== "ready")
        throw new Error("Buzz is not connected to this community");
      const source = ownerReads(agents.relay(agent), agent);
      if (!source) throw new Error("Buzz is not connected to this community");
      const listing = await memoryReads.read(source, agent, signal);
      if (agents.relay(agent)?.snapshot() !== snapshot)
        throw new Error("Community changed during memory read");
      return listing;
    };
    const inline = new InlineAgent({
      spawn,
      current: (lease) =>
        invoke<boolean>("mesh_compute_inference_current", { lease }),
      memories: async (agent, signal) =>
        (await readMemory(agent, signal)).entries,
      remembered: (agent) => {
        const snapshot = agents.relay(agent)?.snapshot();
        if (snapshot?.status === "ready")
          memoryReads.forget(snapshot.session, agent);
      },
    });
    const runtime = new MeshAgentRuntime({
      inline,
      spawn,
      origin: (agent) => agents.relay(agent)?.snapshot().origin,
      prepare: (relay) =>
        invoke<PreparedInference>("mesh_compute_prepare_inference", {
          relay,
          model: "auto",
        }),
      current: (lease) =>
        invoke<boolean>("mesh_compute_inference_current", { lease }),
      chat: (inference, messages) =>
        invoke<string>("mesh_compute_chat", {
          lease: inference.lease,
          model: inference.model,
          messages,
        }),
      dm: (agent, channelId) => {
        const snapshot = agents.relay(agent)?.snapshot();
        return (
          snapshot?.status === "ready" &&
          snapshot.session.channels
            .list()
            .channels.find((row) => row.id === channelId)?.channelType === "dm"
        );
      },
      memories: async (agent, signal) =>
        (await readMemory(agent, signal)).entries,
      coreMemory: async (agent, signal) => {
        try {
          return coreOf(await readMemory(agent, signal));
        } catch (error) {
          signal.throwIfAborted();
          console.warn("Mesh could not read the agent's memory", error);
          return undefined;
        }
      },
      remembered: (agent) => {
        const snapshot = agents.relay(agent)?.snapshot();
        if (snapshot?.status === "ready")
          memoryReads.forget(snapshot.session, agent);
      },
    });
    ctx.effect(() => () => runtime.dispose());
    agents.register<MeshAgentConfig>({
      id: "mesh",
      title: "Shared Compute",
      description:
        "Runs on this community's shared compute: plain chat, or goose with shell, file and Buzz tools.",
      defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
      summary: () => "Shared compute",
      Create: ({ disabled }) => (
        <CommunityComputePage setupOnly disabled={disabled} />
      ),
      tabs: [
        { id: "prompt", title: "Settings", component: MeshAgentTab },
        {
          id: "transcript",
          title: "Transcripts",
          component: createMeshTranscriptTab(inline),
        },
      ],
      // Covers compute startup (native waits up to 120s) plus one reply.
      timeoutMs: 5 * 60_000,
      run: (delivery) => {
        const done = runtime.run(delivery);
        if (delivery.config.mode === "chat") return done;
        delivery.workingUntil(done);
        // Release the host queue so a subsequent mention can steer this run.
      },
    });
  }

  function CommunityComputePage({
    community,
    setupOnly = false,
    disabled = false,
  }: {
    community?: { id: string; name: string };
    setupOnly?: boolean;
    disabled?: boolean;
  }) {
    const snapshot = useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const [status, setStatus] = useState<MeshStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    useEffect(() => {
      let active = true;
      if (isTauri() && status?.sharing)
        void openWidget().catch((reason) => {
          if (active && !disposed)
            setError(`Couldn’t open activity widget: ${String(reason)}`);
        });
      return () => {
        active = false;
      };
    }, [status?.sharing]);
    const [busy, setBusy] = useState(false);
    const sharingAction = useRef(0);
    // Observe the app-owned runtime even while idle, restoring, or recovering
    // from a failed read. A pending selection must not hide native progress.
    useEffect(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      setStatus(null);
      setError(null);
      setStatusError(null);
      if (!isTauri()) return;
      const read = async () => {
        const action = sharingAction.current;
        let delay = 5000;
        try {
          const result = await invoke<MeshStatus>("mesh_compute_status");
          if (
            active &&
            !disposed &&
            snapshot === ctx.relay.snapshot() &&
            action === sharingAction.current
          ) {
            setStatus(result);
            setStatusError(null);
          }
          if (
            result.lifecycle?.state === "starting" ||
            result.lifecycle?.state === "stopping" ||
            result.sharing
          )
            delay = 1000;
        } catch (reason) {
          if (active && !disposed && snapshot === ctx.relay.snapshot())
            setStatusError(String(reason));
        } finally {
          if (active && !disposed)
            timer = setTimeout(() => {
              void read();
            }, delay);
        }
      };
      void read();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [snapshot]);
    // One page Refresh also rereads the community list (no second Refresh).
    const [refreshCount, setRefreshCount] = useState(0);
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
    const boundCommunity = status?.available ? status.boundCommunity : null;
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
    const share = (
      clearSaved = false,
      hosting?: { model: string; maxVramGb: number },
      startAuto = false,
    ) => {
      const action = runShare(clearSaved, hosting, startAuto);
      lastShareAction = action;
      return action;
    };
    const runShare = async (
      clearSaved: boolean,
      hosting: { model: string; maxVramGb: number } | undefined,
      startAuto: boolean,
    ) => {
      const action = ++sharingAction.current;
      setBusy(true);
      setError(null);
      try {
        const turningOff =
          !startAuto && (clearSaved || Boolean(status?.sharing));
        // Capture the operation's owner before awaiting; identity or community
        // changes while waiting retire this action.
        const community = scope;
        const owner = viewer;
        const current = () =>
          !disposed &&
          action === sharingAction.current &&
          snapshot === ctx.relay.snapshot() &&
          scope === community &&
          viewer === owner;
        let selected: Promise<string | undefined> | undefined;
        let id: string | undefined;
        try {
          ({ selected, id } = await currentLease());
        } catch (reason) {
          // Without a lease (e.g. an unrecovered failed runtime blocks selection),
          // Off still clears saved consent; it never starts or stops Mesh.
          if (!turningOff || !community || !owner || !current()) throw reason;
          await invoke("mesh_compute_disarm", {
            community,
            expectedViewer: owner,
          });
          const result = await invoke<MeshStatus>("mesh_compute_status");
          if (
            !disposed &&
            action === sharingAction.current &&
            snapshot === ctx.relay.snapshot()
          )
            setStatus(result);
          return;
        }
        if (!id) throw new Error("Mesh native runtime is unavailable");
        if (!current() || selected !== lease)
          throw new Error("Community changed");
        if (startAuto) {
          const latest = await invoke<MeshStatus>("mesh_compute_status");
          if (!current() || selected !== lease)
            throw new Error("Community changed");
          if (latest.boundCommunity !== viewedCommunity)
            throw new Error(
              "Open Shared compute settings to switch communities first",
            );
          // A second creation view must not replace sharing started elsewhere.
          if (latest.sharing) {
            setStatus(latest);
            return;
          }
        }
        await invoke("mesh_compute_share", {
          lease: id,
          model: startAuto ? "auto" : turningOff ? null : hosting?.model,
          maxVramGb: hosting?.maxVramGb ?? null,
          auto: startAuto,
        });
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (
          !disposed &&
          action === sharingAction.current &&
          snapshot === ctx.relay.snapshot()
        )
          setStatus(result);
      } catch (error) {
        if (
          !disposed &&
          action === sharingAction.current &&
          snapshot === ctx.relay.snapshot()
        ) {
          setError(String(error));
          // Share Off may clear intent even when shutdown fails.
          const result = await invoke<MeshStatus>("mesh_compute_status").catch(
            () => null,
          );
          if (
            result &&
            !disposed &&
            action === sharingAction.current &&
            snapshot === ctx.relay.snapshot()
          )
            setStatus(result);
        }
      } finally {
        if (!disposed && action === sharingAction.current) setBusy(false);
      }
    };
    const refresh = async () => {
      setStatusError(null);
      setRefreshCount((value) => value + 1);
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
    if (setupOnly)
      return (
        <MeshCreateSetup
          status={status}
          busy={busy}
          disabled={disabled || snapshot.status !== "ready"}
          leaseReady={leaseReady}
          otherCommunity={otherCommunity}
          error={error ?? statusError}
          share={() => void share(false, undefined, true)}
          refresh={() => void refresh()}
        />
      );
    return (
      <ComputeSettings
        key={`${snapshot.viewer}:${snapshot.scope}`}
        community={community?.id ?? viewedCommunity ?? ""}
        relay={ctx.relay}
        status={status}
        busy={busy}
        leaseReady={leaseReady && snapshot.status === "ready"}
        otherCommunity={otherCommunity}
        error={
          error ??
          statusError ??
          status?.settingsError ??
          status?.reason ??
          status?.lifecycle?.reason
        }
        refreshKey={refreshCount}
        share={share}
        openWidget={() => {
          setError(null);
          void openWidget().catch((reason) => {
            if (!disposed)
              setError(`Couldn’t open activity widget: ${String(reason)}`);
          });
        }}
        refresh={() => void refresh()}
      >
        {isTauri() &&
          status?.available &&
          !otherCommunity &&
          phase === "ready" && (
            <ComputeActivity data={status.activity ?? null} />
          )}
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
        {isTauri() &&
          status?.available &&
          community &&
          ctx.agents &&
          snapshot.status === "ready" &&
          snapshot.origin && (
            <MeshHelpers
              key={`${snapshot.origin}:${snapshot.viewer}`}
              agents={ctx.agents}
            />
          )}
      </ComputeSettings>
    );
  }
  ctx.settingsCards.register({
    id: "mesh",
    title: "Shared compute",
    icon: CpuIcon,
    component: CommunityComputePage,
  });
};
