// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { useState, useSyncExternalStore } from "react";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { usePages } from "../features/pages/usePages";
import { AppShell } from "./shell/AppShell";
import { Home } from "./shell/Home";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { PanelCard } from "../features/panels/PanelCard";

export function App({ services }: { services: AppServices }) {
  const { plugins } = services;
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const pages = usePages(services.pages);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const [home, setHome] = useState(true);
  const select = (key: string) => {
    setHome(key === "home");
    if (key !== "home") pages.select(key);
  };
  const selected = home ? "home" : pages.selected;
  const presentation = home
    ? shellPresentation.home
    : pages.current
      ? pagePresentation(pages.current)
      : shellPresentation.settings;
  const selectedPanel = launcher.selected;
  const companion = selectedPanel && (
    <PanelCard
      panel={selectedPanel}
      target={selectedPanel.launcher?.target ?? ""}
      close={launcher.close}
    />
  );
  const pageOwnsCompanion = !home && !!pages.current?.companion;
  return (
    <AppShell
      communities={services.communities}
      launchers={
        <PanelLaunchers
          panels={launcher.available}
          selected={selectedPanel}
          launch={launcher.launch}
        />
      }
      companion={pageOwnsCompanion ? undefined : companion}
      pages={startup === "ready" ? pages.available : []}
      selected={selected}
      onSelect={select}
      tone={presentation.tone}
      workspace={
        startup === "ready" && !home && pages.current?.layout === "workspace"
      }
    >
      {startup === "recovery" ? (
        <RecoveryScreen plugins={plugins} />
      ) : startup === "loading" ? (
        <p role="status">Opening Buzz…</p>
      ) : home ? (
        <Home pages={pages.available} onSelect={select} />
      ) : pages.current ? (
        <PageView
          page={pages.current}
          companion={pageOwnsCompanion ? companion : undefined}
        />
      ) : (
        <Settings
          plugins={plugins}
          communities={services.communities}
          appearance={services.appearance}
        />
      )}
    </AppShell>
  );
}
