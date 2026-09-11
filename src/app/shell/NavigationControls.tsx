import { useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Navigation } from "../../features/navigation/controller";
export function NavigationControls({ navigation }: { navigation: Navigation }) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  return (
    <nav
      className="mr-2 flex shrink-0 items-center gap-0.5"
      aria-label="Navigation history"
    >
      <button
        type="button"
        className="shell-icon disabled:opacity-30"
        aria-label="Go back"
        title="Go back"
        disabled={!state.canGoBack}
        onClick={navigation.back}
      >
        <ArrowLeft size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="shell-icon disabled:opacity-30"
        aria-label="Go forward"
        title="Go forward"
        disabled={!state.canGoForward}
        onClick={navigation.forward}
      >
        <ArrowRight size={17} aria-hidden="true" />
      </button>
    </nav>
  );
}
