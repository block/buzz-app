import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import type { RelayData } from "../../features/relay/service";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ComputeChoice } from "./ComputeChoice";
import { CommunityMesh } from "./CommunityMesh";
import { DownloadProgress } from "./DownloadProgress";
import { EmbeddedActivity } from "./EmbeddedActivity";
import type { MeshStatus } from "./index";
import styles from "./Compute.module.css";

type Hosting = {
  memoryDisplay: string;
  maxVramGb: number;
  model: string | null;
};

export function ComputeSettings({
  community,
  relay,
  status,
  busy,
  leaseReady,
  otherCommunity,
  error,
  refreshKey,
  share,
  refresh,
  openWidget,
  children,
}: {
  community: string;
  relay: RelayData;
  status: MeshStatus | null;
  busy: boolean;
  leaseReady: boolean;
  otherCommunity: boolean;
  error: string | null | undefined;
  refreshKey: number;
  share(
    clearSaved: boolean,
    hosting?: { model: string; maxVramGb: number },
  ): Promise<void>;
  refresh(): void;
  openWidget?(): void;
  children?: ReactNode;
}) {
  const [hosting, setHosting] = useState<Hosting>();
  const [catalogError, setCatalogError] = useState<string>();
  const [contributors, setContributors] = useState<number | null>(null);
  const [choice, setChoice] = useState("use");
  const [requested, setRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    void refreshKey;
    let active = true;
    setCatalogError(undefined);
    void invoke<{ hosting?: Hosting }>("mesh_compute_catalog").then(
      (catalog) => {
        if (active) setHosting(catalog.hosting);
      },
      () => {
        if (active) setCatalogError("Couldn’t check this computer. Try again.");
      },
    );
    return () => {
      active = false;
    };
  }, [refreshKey]);
  const phase = status?.lifecycle?.state;
  const sharing =
    !otherCommunity &&
    Boolean(status?.sharing || status?.savedSharing?.enabled);
  const localReady =
    sharing && phase === "ready" && status?.modelReady === true;
  const failed = phase === "failed";
  const download =
    !otherCommunity &&
    (phase === "starting" || phase === "ready") &&
    !stopping &&
    status?.download &&
    !status.download.done
      ? status.download
      : null;
  const localPending =
    !otherCommunity &&
    (requested ||
      Boolean(download) ||
      (sharing && (phase === "starting" || phase === "ready") && !localReady));
  const canHost =
    Boolean(hosting?.model) && status?.available === true && !otherCommunity;
  const change = async (value: string) => {
    if (stopping || phase === "stopping") return;
    if (value === "use") {
      setChoice("use");
      if (!sharing && !localPending) return;
      setStopping(true);
      try {
        await share(true);
      } finally {
        setStopping(false);
        setRequested(false);
      }
    } else if (!sharing && !requested && hosting?.model && canHost && !failed) {
      setRequested(true);
      try {
        await share(false, {
          model: hosting.model,
          maxVramGb: hosting.maxVramGb,
        });
      } finally {
        setRequested(false);
      }
    }
  };
  return (
    <section className={styles.settings} aria-label="Shared compute settings">
      <Header
        title="Shared compute"
        subtitle="Free agents, powered by your community."
      />
      <SettingsGroup layout="form">
        <ComputeChoice
          label="How would you like to use shared compute?"
          value={sharing || localPending ? "share" : choice}
          onChange={(value) => {
            setChoice(value);
            if (value === "use") void change(value);
          }}
          disabled={
            !leaseReady ||
            !status?.available ||
            otherCommunity ||
            stopping ||
            phase === "stopping" ||
            (busy && !sharing && !requested)
          }
          canHost={(canHost || sharing || localPending) && !failed}
          belowMinimum={!!hosting && hosting.maxVramGb < 4}
          memoryDisplay={hosting?.memoryDisplay}
          contributors={contributors}
        />
        <div className={styles.computeState}>
          {status?.available && !otherCommunity && (
            <div className={styles.widgetCard}>
              <EmbeddedActivity
                data={status.activity ?? null}
                sharing={Boolean(status.sharing)}
                state={
                  phase === "ready"
                    ? status.modelReady
                      ? "running"
                      : "starting"
                    : (phase ?? "stopped")
                }
              />
              {openWidget && (
                <div className={styles.widgetPopout}>
                  <IconButton
                    size="xs"
                    aria-label="Open activity widget"
                    title="Open activity widget"
                    icon={<ArrowSquareOutIcon size={16} />}
                    variant="subtle"
                    disabled={!status.sharing}
                    onClick={openWidget}
                  />
                </div>
              )}
            </div>
          )}
          <p
            role="status"
            aria-label="Compute status"
            className="m-0 text-body"
          >
            {otherCommunity
              ? "This computer is connected to another community."
              : !status
                ? "Checking shared compute…"
                : !status.available
                  ? "Open a supported Buzz desktop build to use shared compute."
                  : stopping || phase === "stopping"
                    ? "Stopping shared compute…"
                    : failed
                      ? "Shared compute couldn’t start. Restart Buzz to try again."
                      : download
                        ? "Getting this computer ready. You can keep using Buzz."
                        : localReady
                          ? "You’re helping power agents for this community."
                          : localPending
                            ? "Starting shared compute…"
                            : phase === "starting"
                              ? "Connecting to community compute…"
                              : sharing
                                ? "Sharing is enabled, but this computer isn’t running."
                                : contributors === null
                                  ? "Checking community compute…"
                                  : contributors === 0
                                    ? "No shared compute is available yet. Agents can run once someone starts sharing."
                                    : "Your agents use compute shared by your community."}
          </p>
          {choice === "share" && !sharing && !localPending && !stopping && (
            <Button
              disabled={!canHost || !leaseReady || busy || failed}
              onClick={() => {
                void change("share");
              }}
            >
              Share this computer
            </Button>
          )}
          {download && <DownloadProgress download={download} />}
          {localPending && !failed && (
            <Button
              variant="subtle"
              size="sm"
              disabled={stopping}
              onClick={() => {
                void change("use");
              }}
            >
              Cancel
            </Button>
          )}
          {localReady && (
            <p className="m-0 text-body-sm text-secondary">
              Sharing stays on when you reopen Buzz. Switch to community compute
              to stop sharing.
            </p>
          )}
          {(error || catalogError) && (
            <div role="alert" className="text-body-sm text-danger">
              <p>Shared compute needs attention. {error || catalogError}</p>
              <Button
                variant="subtle"
                size="sm"
                onClick={refresh}
                disabled={busy}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      </SettingsGroup>
      {children}
      {!otherCommunity && status?.available && (
        <CommunityMesh
          community={community}
          relay={relay}
          refreshKey={refreshKey}
          presentation="availability"
          onAvailabilityChange={(_, count) => setContributors(count)}
        />
      )}
    </section>
  );
}
