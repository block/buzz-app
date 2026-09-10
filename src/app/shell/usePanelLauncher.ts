import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";

type Opened = { panel: RegisteredPanel; trigger: HTMLButtonElement };
export function usePanelLauncher(panels: Panels, ready: boolean) {
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opened>();
  // Exact installation object, not just key/revision: same-revision re-enable is new intent.
  const selected =
    ready && opened && available.includes(opened.panel)
      ? opened.panel
      : undefined;
  useEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const previous = useRef<Opened>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = opened;
    if (
      before &&
      !opened &&
      panels.snapshot().includes(before.panel) &&
      before.trigger.isConnected
    )
      before.trigger.focus();
  }, [opened, panels]);
  return {
    available: ready ? available : [],
    selected,
    launch(panel: RegisteredPanel, trigger: HTMLButtonElement) {
      if (ready && panel.launcher && panels.snapshot().includes(panel))
        setOpened((current) =>
          current?.panel === panel ? undefined : { panel, trigger },
        );
    },
    close() {
      // Bind to this opening, not merely this panel: reopening gets a new lifetime.
      setOpened((current) => (current === opened ? undefined : current));
    },
  };
}
