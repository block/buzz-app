import { useState, useSyncExternalStore } from "react";
import type { PagesReader } from "./service";

// The service owns shared pages; this hook owns this component’s subscription and selection.
export function usePages(service: PagesReader) {
  const available = useSyncExternalStore(service.subscribe, service.snapshot);
  const [selected, select] = useState<string | null>(null);
  const current =
    selected === "settings"
      ? null
      : (available.find((page) => page.key === selected) ??
        available[0] ??
        null);
  return { available, current, selected: current?.key ?? "settings", select };
}
