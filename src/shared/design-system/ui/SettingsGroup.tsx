import type { ReactNode } from "react";

/** A quiet boundary for related settings; children own controls and state. */
export function SettingsGroup({
  children,
  layout = "rows",
}: {
  children: ReactNode;
  layout?: "rows" | "form";
}) {
  return (
    <div data-buzz-ui="" className="buzz-settings-group" data-layout={layout}>
      {children}
    </div>
  );
}
