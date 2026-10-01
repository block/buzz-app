// Consumer presentation adapted from feat/community-compute-plugin @ b4a910e.
// Host lifecycle/leases remain owned by this plugin, not the donor's sharing service.
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import styles from "./Compute.module.css";

export function ConsumerComputeView({
  active,
  starting,
  disabled,
  status,
  error,
  refreshDisabled,
  connect,
  refresh,
}: {
  active: boolean;
  starting: boolean;
  disabled: boolean;
  status: string;
  error: string | undefined | null;
  refreshDisabled: boolean;
  connect: () => void;
  refresh: () => void;
}) {
  return (
    <FullPageSurface aria-label="Compute consumer">
      <div className="h-full overflow-auto p-panel-inset text-body">
        <div className={styles.content}>
          <h1 className="m-0 text-title text-primary">Use shared compute</h1>
          <p className="text-body text-secondary">
            Use a model shared by another device in the selected community. This
            app does not download or serve a local model. Your prompts run on
            other members’ machines.
          </p>
          <Button onClick={connect} disabled={disabled}>
            {active
              ? starting
                ? "Cancel connection"
                : "Disconnect"
              : "Connect to community compute"}
          </Button>
          <p role="status">{status}</p>
          {status === "Running" && (
            <p className="text-body-sm text-secondary">
              The local consumer is running. This does not confirm that a
              provider is reachable.
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={refreshDisabled}
          >
            Refresh
          </Button>
          {error && (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </FullPageSurface>
  );
}
