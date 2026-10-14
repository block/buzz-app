import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Compute.module.css";
import type { AgentSetupAction } from "../../features/agents/service";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { RelayData } from "../../features/relay/service";
import { SparklesIcon, BuzzIcon } from "../../shared/design-system/icons";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { CommunityMesh } from "./CommunityMesh";
import type { MeshStatus } from "./index";

type Catalog = {
  hosting?: { memoryDisplay: string; maxVramGb: number; model: string | null };
  entries: {
    model: string;
    name: string;
    size: string | null;
    installed: boolean;
  }[];
};

/** Setup borrows the plugin's existing sharing lifecycle; it owns only the draft choice. */
export function MeshSetup({
  onActionChange,
  community,
  relay,
  status,
  busy,
  disabled,
  otherCommunity,
  leaseReady,
  error,
  refreshKey,
  share,
  onReadyChange,
}: {
  onActionChange(action: AgentSetupAction): void;
  community: string;
  relay: RelayData;
  status: MeshStatus | null;
  busy: boolean;
  disabled: boolean;
  otherCommunity: boolean;
  leaseReady: boolean;
  error: string | null;
  refreshKey: number;
  share(model: string, maxVramGb: number): Promise<void> | void;
  onReadyChange(ready: boolean, advance?: boolean): void;
}) {
  const setupKey = `buzz.mesh.setup:${JSON.stringify([relay.snapshot().viewer, community])}`;
  const [completedBefore, setCompletedBefore] = useState(() => {
    try {
      return localStorage.getItem(setupKey) === "complete";
    } catch {
      return false;
    }
  });
  const complete = useCallback(() => {
    try {
      localStorage.setItem(setupKey, "complete");
    } catch {
      /* Storage may be unavailable; readiness still permits this agent. */
    }
    setCompletedBefore(false);
    onReadyChange(true, true);
  }, [setupKey, onReadyChange]);
  const [requested, setRequested] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [contributors, setContributors] = useState<number | null>(null);
  const onAvailabilityChange = useCallback(
    (available: boolean | null, count: number | null) => {
      setAvailable(available);
      setContributors(count);
    },
    [],
  );
  const [choice, setChoice] = useState<string | null>(
    completedBefore ? "use" : null,
  );
  useEffect(() => {
    void refreshKey;
    let active = true;
    setCatalogError(null);
    setCatalog(null);
    void invoke<Catalog>("mesh_compute_catalog").then(
      (result) => {
        if (active) setCatalog(result);
      },
      (reason) => {
        if (active) setCatalogError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [refreshKey]);
  const hosting = catalog?.hosting;
  const model = hosting?.model ?? "";
  const belowMinimum = !!hosting && hosting.maxVramGb < 4;
  const canHost = !!model && !otherCommunity && status?.available === true;
  const sharing =
    !otherCommunity &&
    Boolean(status?.sharing || status?.savedSharing?.enabled);
  const localReady =
    !otherCommunity &&
    Boolean(status?.sharing) &&
    status?.modelReady === true &&
    status?.lifecycle?.state === "ready";
  const wantsHost =
    sharing || (choice ?? (canHost ? "share" : "use")) === "share";
  const failed = status?.lifecycle?.state === "failed";
  // Creating an agent needs a compute choice, not a completed download.
  const ready =
    status?.available === true &&
    !failed &&
    !error &&
    !startError &&
    (sharing || requested || (available === true && !wantsHost));
  useEffect(() => {
    if (ready && completedBefore) complete();
    else onReadyChange(ready);
  }, [ready, completedBefore, complete, onReadyChange]);
  const start = () => {
    if (!hosting || requested || busy || !canHost || !leaseReady) return;
    setRequested(true);
    setStartError(null);
    void Promise.resolve()
      .then(() => share(model, hosting.maxVramGb))
      .catch((reason) => {
        setRequested(false);
        setStartError(String(reason));
      });
    complete();
  };
  useEffect(() => {
    onActionChange({
      summary: localReady
        ? "You are sharing compute with this community. Change in Settings → Shared compute."
        : requested || sharing
          ? "Setting up shared compute in the background. Change in Settings → Shared compute."
          : "Using community compute · Change in Settings → Shared compute",
      enabled:
        !disabled &&
        (ready || (!busy && wantsHost && canHost && leaseReady && !failed)),
      run: () => {
        if (wantsHost && !sharing && !requested) start();
        else if (ready) complete();
      },
    });
  });
  return (
    <section
      aria-label="Set up shared compute"
      className="grid gap-4 text-center"
    >
      <CommunityMesh
        community={community}
        relay={relay}
        refreshKey={refreshKey}
        presentation="availability"
        onAvailabilityChange={onAvailabilityChange}
      />
      <Field
        label={
          <span className="block text-center">How will your agent run?</span>
        }
        nativeLabel={false}
      >
        <RadioGroup
          variant="segmented"
          value={wantsHost ? "share" : "use"}
          onValueChange={setChoice}
          disabled={disabled || busy || sharing}
        >
          <Tooltip
            content={
              <span className="block text-center">
                Share up to 25% of your computer’s memory to power community
                agents for free. The more people contribute, the more agents
                your community can support.
              </span>
            }
          >
            <Radio
              value="share"
              disabled={!canHost}
              label={
                <span className={styles.choiceLabel}>
                  <span>Use this computer</span>
                  {(canHost || belowMinimum) && (
                    <span
                      className={`text-caption ${styles.recommended}`}
                      data-requirement={belowMinimum || undefined}
                    >
                      {belowMinimum ? "16 GB required" : "Recommended"}
                    </span>
                  )}
                </span>
              }
              description={
                belowMinimum
                  ? `Your computer has ${hosting?.memoryDisplay} of memory. You can still use compute shared by your community.`
                  : "Help power agents for your Buzz community. Free to share."
              }
              icon={<SparklesIcon size={18} />}
            />
          </Tooltip>
          <Tooltip
            content={
              <span className="block text-center">
                Run your agents for free on computers shared by your community.
                Nothing to download, and no model runs on your computer.
              </span>
            }
          >
            <Radio
              value="use"
              label="Use community compute"
              description={
                contributors === null
                  ? "Checking community compute…"
                  : contributors === 0
                    ? "No one is sharing compute yet, so your agent won’t run."
                    : contributors === 1
                      ? "Powered by 1 person in your Buzz community. Free to use."
                      : `Powered by ${contributors.toLocaleString()} people in your Buzz community. Free to use.`
              }
              icon={<BuzzIcon size={18} />}
            />
          </Tooltip>
        </RadioGroup>
      </Field>
      {available === false && !localReady && !requested && !sharing && (
        <p className="m-0 text-center text-body-sm text-secondary">
          {canHost ? (
            <strong>
              No one is sharing compute yet. Share this computer so you and your
              community can run agents for free.
            </strong>
          ) : otherCommunity ? (
            "This computer is connected to another community. Open Shared compute settings to switch communities, then check again."
          ) : catalog && status ? (
            "There’s no compute to use, and we haven’t found a model this computer can host within its memory budget. Ask someone with a more capable computer to share, then check again."
          ) : (
            "There’s no community compute yet. Checking whether this computer can share…"
          )}
        </p>
      )}
      <p className="m-0 text-center text-body-sm text-secondary">
        You can change this any time in Settings → Shared Compute.
      </p>
      {(error ||
        startError ||
        catalogError ||
        failed ||
        status?.available === false) && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error ??
            startError ??
            (failed
              ? "Shared compute needs recovery. Restart Buzz, then try again."
              : null) ??
            (status?.available === false
              ? "Shared compute isn’t available in this build."
              : `Couldn’t check this computer: ${catalogError}`)}
        </p>
      )}
    </section>
  );
}
