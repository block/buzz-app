// Consumer presentation adapted from feat/community-compute-plugin @ b4a910e.
// Host lifecycle/leases remain owned by this plugin, not the donor's sharing service.
import type { ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import styles from "./Compute.module.css";

export function ConsumerComputeView({
  headerControl,
  children,
  status,
  error,
  refreshDisabled,
  refresh,
}: {
  headerControl?: ReactNode;
  children?: ReactNode;
  status?: string | undefined;
  error: string | undefined | null;
  refreshDisabled: boolean;
  refresh: () => void;
}) {
  return (
    <section
      aria-label="Compute consumer"
      className={`${styles.content} text-body`}
    >
      <Header title="Shared compute" actions={headerControl} />
      {children}
      <details className={styles.options}>
        <summary className="text-body-sm">
          Connection · <span role="status">{status}</span>
        </summary>
        <div className={styles.toolbar}>
          <Button
            variant="subtle"
            size="sm"
            onClick={refresh}
            disabled={refreshDisabled}
          >
            Refresh
          </Button>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
