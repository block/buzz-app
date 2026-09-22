import { useEffect, useState } from "react";
import {
  observeNativeSharing,
  openComputeWidget,
} from "../../features/community-compute/native";
import { CpuIcon } from "../../shared/design-system/icons/index";

/** The bundled Compute launcher opens a native window, not a companion panel. */
export function ComputeWidgetLauncher() {
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const host = observeNativeSharing();
    if (!host) return;
    const update = () => {
      const { status, error } = host.source.snapshot();
      setSharing(
        !error &&
          !!status?.available &&
          status.state === "running" &&
          status.mode === "serve" &&
          status.preferredMode !== "client",
      );
    };
    const unsubscribe = host.source.subscribe(update);
    update();
    return () => {
      unsubscribe();
      host.dispose();
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!sharing) return null;
  return (
    <>
      <button
        type="button"
        className="shell-icon"
        aria-label="Open Compute widget"
        title="Open Compute widget"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            await openComputeWidget();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setPending(false);
          }
        }}
      >
        <CpuIcon size={18} aria-hidden="true" />
      </button>
      {error && <span role="alert">Couldn’t open Compute widget: {error}</span>}
    </>
  );
}
