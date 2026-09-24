import { useEffect, useState } from "react";
import {
  closeComputeWidget,
  observeNativeSharing,
  openComputeWidget,
} from "../../features/community-compute/native";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { computeLauncherIcon } from "../../shared/design-system/icons/svg";

/** The bundled Compute launcher opens a native window, not a companion panel. */
export function ComputeWidgetLauncher({ enabled = true }: { enabled?: boolean }) {
  const [providerApp, setProviderApp] = useState(false);
  useEffect(() => {
    const host = observeNativeSharing();
    if (!host || !enabled) return;
    let widgetOpen: boolean | null = null;
    let desiredWidgetOpen: boolean | null = null;
    let transitions = Promise.resolve();
    const update = () => {
      const status = host.source.snapshot().status;
      setProviderApp(!!status?.available && status.preferredMode !== "client");
      const shouldOpenWidget = !!(
        status?.available &&
        status.preferredMode !== "client" &&
        status.mode === "serve" &&
        status.state !== "off"
      );
      if (desiredWidgetOpen === shouldOpenWidget) return;
      desiredWidgetOpen = shouldOpenWidget;
      transitions = transitions.then(async () => {
        const desired = desiredWidgetOpen;
        if (desired === null || desired === widgetOpen) return;
        try {
          if (desired) await openComputeWidget();
          else await closeComputeWidget();
          widgetOpen = desired;
        } catch {
          // Keep the toolbar control available for manual recovery.
        }
      });
    };
    const unsubscribe = host.source.subscribe(update);
    update();
    return () => {
      unsubscribe();
      host.dispose();
    };
  }, [enabled]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!enabled || !providerApp) return null;
  return (
    <>
      <IconButton
        type="button"
        aria-label="Open Compute activity widget"
        title="Open Compute activity widget"
        disabled={pending}
        variant="chrome"
        shape="round"
        icon={<img src={computeLauncherIcon} alt="" className="size-4 object-contain" />}
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
      />
      {error && <span role="alert">Couldn’t open Compute widget: {error}</span>}
    </>
  );
}
