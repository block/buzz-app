import { createContext, useContext, type ReactNode } from "react";

/** Retained panel content stays mounted while its tab is not selected or its
 * dock is collapsed. */
const PaneShown = createContext(true);

/** Whether this content is on screen as far as its panel hosts know: its tab
 * is selected and its dock is open. True outside any host. Content that reads
 * the relay can wait until it is shown, and read again when it shows again,
 * as when a link returns to its retained tab. */
export function usePanelShown() {
  return useContext(PaneShown);
}

/** Content under a host that may hide it; nested hosts all have to show it. */
export function PaneShownScope({
  shown,
  children,
}: {
  shown: boolean;
  children: ReactNode;
}) {
  const outer = useContext(PaneShown);
  return (
    <PaneShown.Provider value={outer && shown}>{children}</PaneShown.Provider>
  );
}
