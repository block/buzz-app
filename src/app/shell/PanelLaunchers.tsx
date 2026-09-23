import { useState } from "react";
import { SidebarIcon } from "../../shared/design-system/icons/index";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  type WindowHost,
  type WindowLayout,
  panelTabKey,
} from "../../features/windows/service";
import { PageTab } from "./PageTab";

export function PanelLaunchers({
  panels,
  selected,
  launch,
  windows,
  layout,
  tabsHere,
  detachable,
}: {
  panels: readonly RegisteredPanel[];
  selected: RegisteredPanel | undefined;
  launch(panel: RegisteredPanel, trigger: HTMLButtonElement): void;
  windows: WindowHost;
  layout: WindowLayout;
  tabsHere: number;
  detachable: boolean;
}) {
  return panels
    .filter((panel) => panel.launcher)
    .map((panel) => (
      <PageTab
        key={`${panel.key}:${panel.revision}`}
        tabKey={panelTabKey(panel)}
        name={panel.title}
        launcher
        icon={
          <LauncherIcon
            key={panel.launcher?.icon}
            src={panel.launcher?.icon ?? ""}
          />
        }
        selected={false}
        expanded={panel === selected}
        onSelect={(event) => launch(panel, event.currentTarget)}
        windows={windows}
        layout={layout}
        tabsHere={tabsHere}
        detachable={detachable}
      />
    ));
}
function LauncherIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <SidebarIcon size={18} aria-hidden="true" />
  ) : (
    <img
      src={src}
      alt=""
      // Images are natively draggable; that would hijack the tab's pointer drag.
      draggable={false}
      className="size-4 object-contain"
      onError={() => setFailed(true)}
    />
  );
}
