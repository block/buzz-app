import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useSidebarView } from "../../src/bundled/channels/useSidebarView";

// The real sidebar view hook over a plain list with real layout. The page
// controls when the hook is mounted, where it navigates, and when the
// current entry renders, as a roster or an exact lookup would.
type State = { mounted: boolean; at: string; rows: number[] };
const rows = (count: number) => Array.from({ length: count }, (_, i) => i);
declare global {
  interface Window {
    sidebar: {
      update(next: Partial<State>): void;
      rows: typeof rows;
    };
  }
}

function Sidebar({ at, rows }: Omit<State, "mounted">) {
  const view = useSidebarView("fixture", true, at);
  return (
    <nav
      aria-label="Sidebar"
      ref={view.list}
      style={{ height: 200, overflowY: "auto", width: 200 }}
    >
      {rows.map((id) => (
        <div
          key={id}
          data-row={id}
          aria-current={at === `row:${id}` ? "page" : undefined}
          style={{ height: 40 }}
        >
          Row {id}
        </div>
      ))}
    </nav>
  );
}

function Harness() {
  const [state, setState] = useState<State>({
    mounted: false,
    at: "row:0",
    rows: rows(50),
  });
  window.sidebar = {
    update: (next) => setState((state) => ({ ...state, ...next })),
    rows,
  };
  return state.mounted ? <Sidebar at={state.at} rows={state.rows} /> : null;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Harness />);
