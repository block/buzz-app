import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";

/** The Mac app's choice to lift WebKit's 60 fps rendering cap. The native
 * side saves it and applies it at launch; elsewhere it is not shown. */
export function RefreshRateSetting({ active = true }: { active?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const latest = useRef(0);
  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    invoke<boolean | null>("render_rate_preference").then(
      (saved) => {
        if (current) setEnabled(saved);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);
  const save = (choice: boolean) => {
    const request = ++latest.current;
    setEnabled(choice);
    setUnsaved(false);
    invoke("render_rate_set", { enabled: choice }).catch(() => {
      if (request === latest.current) setUnsaved(true);
    });
  };
  if (enabled === null) return null;
  return (
    <>
      <SwitchPreferenceRow
        label="Match display refresh rate"
        description="Smoother animation on displays faster than 60 Hz. May use more power. Takes effect after restarting Buzz."
        checked={enabled}
        onCheckedChange={save}
      />
      {active && unsaved && (
        <ToastNotice
          title="Refresh rate choice wasn’t saved"
          description="Buzz will keep its previous refresh rate when it restarts. Try again."
        >
          <Button type="button" size="sm" onClick={() => save(enabled)}>
            Retry saving refresh rate
          </Button>
        </ToastNotice>
      )}
    </>
  );
}
