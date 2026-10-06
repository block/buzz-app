// Consumer presentation adapted from feat/community-compute-plugin @ b4a910e.
// Host lifecycle/leases remain owned by this plugin, not the donor's sharing service.
import type { ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import styles from "./Compute.module.css";

export function ConsumerComputeView({
  communityName,
  children,
  status,
  error,
  refreshDisabled,
  refresh,
}: {
  communityName: string | undefined;
  children?: ReactNode;
  status?: string | undefined;
  error: string | undefined | null;
  refreshDisabled: boolean;
  refresh: () => void;
}) {
  return (
    <FullPageSurface aria-label="Compute consumer">
      <div className="h-full overflow-auto p-panel-inset text-body">
        <div className={styles.content}>
          <h1 className="m-0 text-title text-primary">Shared compute</h1>
          {communityName && (
            <p className="text-body text-secondary">
              Shared compute for <strong>{communityName}</strong>
            </p>
          )}
          <p className="text-body-sm text-secondary">
            Use compute from your community, and optionally share this machine.
          </p>
          {status && <p role="status">{status}</p>}
          {children}
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
