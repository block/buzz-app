import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Switch } from "../../shared/design-system/ui/Switch";
import { CommunityComputeTerritoryMap } from "./CommunityComputeTerritoryMap";
import {
  deriveCommunityComputeMapModel,
  type CommunityComputeSnapshotInput,
} from "./communityComputeMapModel";
import styles from "./Compute.module.css";

/** Presentation input. A native controller must own runtime state beyond page mounts. */
export type SharingState = {
  state: "off" | "starting" | "running" | "stopping" | "failed";
  mode: "serve" | "client" | null;
  modelId: string | null;
  detail?: string;
  download?: { received: number; total: number | null };
};
export type SharingRequest = {
  modelId: string;
  maxVramGb?: number;
  mode?: "serve" | "client";
};
export type ComputeControls = {
  status: SharingState;
  canStart?: boolean;
  models: readonly {
    id: string;
    label: string;
    recommended?: boolean;
    tooLarge?: boolean;
  }[];
  start(request: SharingRequest): Promise<void>;
  stop(): Promise<void>;
};
type Props = {
  openWidget?: () => Promise<void>;
  communityName?: string;
  snapshot?: CommunityComputeSnapshotInput | null;
  controls?: ComputeControls;
  statusError?: string;
  sharingError?: string;
  retryStatus?: () => void;
  preview?: boolean;
};

/** The normal plugin has no controls until a real native provider is wired in.
 * The separate fixture supplies these inputs to exercise the presentation only. */
export function CommunityComputeView({
  openWidget,
  communityName,
  snapshot,
  controls,
  statusError,
  sharingError,
  retryStatus,
  preview = false,
}: Props) {
  const [model, setModel] = useState<string | null>(null);
  const [memory, setMemory] = useState("");
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const command = useRef(0);
  const inFlight = useRef(false);
  const id = useId();
  const status = controls?.status;
  const sharing = status?.mode === "serve" && status.state !== "off";
  const running = sharing && status?.state === "running";
  const consuming = status?.mode === "client" && status.state !== "off";
  const recommended = controls?.models.find(
    (entry) => entry.recommended && !entry.tooLarge,
  )?.id;
  const selectedModel =
    (sharing ? status?.modelId : null) ?? model ?? recommended ?? "";
  const busy =
    pending !== null ||
    status?.state === "starting" ||
    status?.state === "stopping";
  const maxVram = memory.trim() ? Number(memory) : undefined;
  const invalidMemory =
    maxVram !== undefined && (!Number.isFinite(maxVram) || maxVram <= 0);
  const tooLarge = controls?.models.find(
    (entry) => entry.id === selectedModel.trim(),
  )?.tooLarge;
  const occupied =
    status &&
    status.state !== "off" &&
    status.state !== "failed" &&
    status.mode === null;
  const map =
    snapshot === undefined ? null : deriveCommunityComputeMapModel(snapshot);
  const showMap = map && map.kpis.contributorMemberCount >= 6;

  useEffect(
    () => () => {
      command.current++;
      inFlight.current = false;
    },
    [],
  );

  // Startup may keep awaiting readiness after authoritative status turns running.
  // Retire the old completion so a later Stop cannot be overwritten by it.
  useEffect(() => {
    if (
      pending === "start" &&
      status?.mode === "serve" &&
      (status.state === "running" || status.state === "failed")
    ) {
      command.current++;
      inFlight.current = false;
      setPending(null);
    }
  }, [pending, status?.state, status?.mode]);

  async function changeSharing(next: boolean) {
    const cancelling =
      !next &&
      status?.state === "starting" &&
      status.mode === "serve" &&
      pending !== "stop";
    if (
      !controls ||
      (inFlight.current && !cancelling) ||
      (busy && !cancelling) ||
      occupied ||
      (!next && !sharing)
    )
      return;
    if (
      next &&
      (controls.canStart === false ||
        !selectedModel.trim() ||
        invalidMemory ||
        tooLarge)
    )
      return;
    const sequence = ++command.current;
    inFlight.current = true;
    setPending(next ? "start" : "stop");
    setError(null);
    try {
      if (next)
        await controls.start({
          modelId: selectedModel.trim(),
          ...(maxVram === undefined ? {} : { maxVramGb: maxVram }),
        });
      else await controls.stop();
    } catch (reason) {
      if (sequence === command.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === command.current) {
        inFlight.current = false;
        setPending(null);
      }
    }
  }

  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Compute">
        <div className="h-full min-h-0 overflow-auto p-panel-inset text-body">
          <div className={styles.content}>
            <header>
              <h1 className="m-0 text-title text-primary">Compute</h1>
              <p className="text-body text-secondary">
                Share your machine to help your community run its agents.
              </p>
              {openWidget && (
                <Button
                  onClick={() => {
                    void openWidget().catch((reason) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    );
                  }}
                >
                  Open activity widget
                </Button>
              )}
            </header>
            {preview && (
              <p className={styles.notice} role="note">
                <strong>Interactive preview.</strong> All people, models and
                progress shown here are sample data. No compute is started or
                downloaded.
              </p>
            )}
            <section className={styles.sharing} aria-label="Sharing">
              <Switch
                label={
                  running ? "You’re sharing compute" : "Share your machine"
                }
                checked={!!sharing}
                disabled={
                  !controls ||
                  busy ||
                  !!occupied ||
                  (!sharing &&
                    (controls?.canStart === false ||
                      !selectedModel.trim() ||
                      invalidMemory ||
                      !!tooLarge))
                }
                onCheckedChange={(next) => {
                  void changeSharing(next);
                }}
              />
              <p className="m-0 text-body text-secondary" role="status">
                {!controls
                  ? "Sharing compute isn’t available in this build yet."
                  : pending === "stop" || status?.state === "stopping"
                    ? "Stopping shared compute…"
                    : running
                      ? `This machine is sharing compute with ${communityName || "your community"}.`
                      : status?.state === "failed"
                        ? status.detail ||
                          "Sharing failed. Turn sharing off before trying again."
                        : busy
                          ? status?.detail || "Preparing shared compute…"
                          : consuming
                            ? "You’re using community compute. Sharing may require restarting Buzz."
                            : controls.canStart === false
                              ? "Connect to a community before starting sharing."
                              : "Choose a model, then turn on sharing."}
              </p>
              {status?.state === "starting" &&
                status.mode === "serve" &&
                pending !== "stop" && (
                  <Button
                    onClick={() => {
                      void changeSharing(false);
                    }}
                  >
                    Cancel startup
                  </Button>
                )}
              {sharingError && (
                <p role="alert" className="text-body text-secondary">
                  {sharingError}
                </p>
              )}
              {error && (
                <p role="alert" className="text-body text-primary">
                  {error}
                </p>
              )}
              {controls && (
                <>
                  <div className={styles.field}>
                    <label htmlFor={`${id}-model`} className="text-label">
                      Model to share
                    </label>
                    <input
                      id={`${id}-model`}
                      className={styles.input}
                      value={selectedModel}
                      list={`${id}-models`}
                      disabled={!!sharing || busy}
                      placeholder="Model reference or local file"
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <datalist id={`${id}-models`}>
                      {controls.models
                        .filter((entry) => !entry.tooLarge)
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                            {entry.recommended ? " — Recommended" : ""}
                          </option>
                        ))}
                    </datalist>
                    <p className="m-0 text-body-sm text-secondary">
                      Buzz downloads the selected model when sharing starts.
                    </p>
                    {tooLarge && (
                      <p role="alert" className="m-0 text-body-sm">
                        This model needs more memory than this machine can
                        share.
                      </p>
                    )}
                  </div>
                  {busy && status?.download && (
                    <DownloadProgress download={status.download} />
                  )}
                  <details>
                    <summary className="cursor-pointer text-label">
                      Advanced
                    </summary>
                    <div className={styles.field}>
                      <label htmlFor={`${id}-memory`} className="text-label">
                        Maximum shared memory (GB)
                      </label>
                      <input
                        id={`${id}-memory`}
                        className={styles.input}
                        inputMode="decimal"
                        type="number"
                        min="0.1"
                        step="any"
                        placeholder="Use the recommended limit"
                        value={memory}
                        disabled={!!sharing || busy}
                        aria-invalid={invalidMemory}
                        aria-describedby={
                          invalidMemory ? `${id}-memory-error` : undefined
                        }
                        onChange={(event) => setMemory(event.target.value)}
                      />
                      {invalidMemory && (
                        <p
                          id={`${id}-memory-error`}
                          role="alert"
                          className="m-0 text-body-sm"
                        >
                          Enter a number greater than zero.
                        </p>
                      )}
                      {status?.detail && (
                        <p className="text-body-sm text-secondary">
                          {status.detail}
                        </p>
                      )}
                    </div>
                  </details>
                </>
              )}
            </section>
            <section aria-label="Community mesh">
              <h2 className="text-heading">Community mesh</h2>
              {statusError ? (
                <div role="alert">
                  <p className="text-body text-secondary">{statusError}</p>
                  {retryStatus && (
                    <Button onClick={retryStatus}>Refresh status</Button>
                  )}
                </div>
              ) : snapshot === undefined ? (
                <p className="text-body text-secondary">
                  Community compute status isn’t connected in this build yet.
                </p>
              ) : snapshot === null ? (
                <p role="status" className="text-body text-secondary">
                  Checking community compute…
                </p>
              ) : (
                <>
                  <p className="text-body text-secondary">
                    {map?.kpis.contributorMemberCount === 0
                      ? "No one is sharing compute yet."
                      : `${map?.kpis.contributorMemberCount} ${map?.kpis.contributorMemberCount === 1 ? "person is" : "people are"} contributing compute.`}
                  </p>
                  <dl className={styles.metrics}>
                    <div>
                      <dt className="text-body-sm text-secondary">
                        Shared memory
                      </dt>
                      <dd className="m-0 text-heading">
                        {map?.kpis.sharedCapacityGb == null
                          ? "Not reported"
                          : `${Math.round(map.kpis.sharedCapacityGb)} GB`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-body-sm text-secondary">
                        Models available
                      </dt>
                      <dd className="m-0 text-heading">
                        {map?.kpis.modelCount}
                      </dd>
                    </div>
                  </dl>
                  {showMap && <CommunityComputeTerritoryMap model={map} />}
                </>
              )}
            </section>
            <section className={styles.agent} aria-label="Community agents">
              <h2 className="m-0 text-heading">
                Put the community mesh to work
              </h2>
              <p className="m-0 text-body text-secondary">
                Community-powered agent creation isn’t available in this build
                yet.
              </p>
              <Button disabled>Create community agent</Button>
            </section>
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}

function DownloadProgress({
  download,
}: {
  download: NonNullable<SharingState["download"]>;
}) {
  const received = Number.isFinite(download.received)
    ? Math.max(0, download.received)
    : 0;
  const total = download.total;
  const percent =
    total !== null && Number.isFinite(total) && total > 0
      ? Math.min(100, Math.round((received / total) * 100))
      : undefined;
  return (
    <div className={styles.field}>
      <progress
        aria-label="Model download"
        max={100}
        value={percent}
        className="w-full"
      />
      <span className="text-body-sm text-secondary">
        {percent === undefined
          ? "Downloading model…"
          : `Downloading model · ${percent}%`}
      </span>
    </div>
  );
}
