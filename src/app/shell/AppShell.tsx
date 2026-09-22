import { type ReactNode, useSyncExternalStore } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { HouseIcon } from "../../shared/design-system/icons/index";
import { isTauri } from "@tauri-apps/api/core";
import type { RegisteredPage } from "../../features/pages/service";
import type { Communities } from "../../features/communities/service";
import type { WindowHost } from "../../features/windows/service";
import { CommunitySwitcher } from "../../features/communities/CommunitySwitcher";
import { ProfileButton } from "./ProfileButton";
import { PageSearch } from "./PageSearch";
import { PageTab } from "./PageTab";
import { orderPages, pagePresentation } from "./presentation";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { macTitleBarDragHandlers } from "./title-bar";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
const titleBarDragProps = macDesktop ? macTitleBarDragHandlers : {};

export function AppShell({
  pages,
  panelCount = 0,
  selected,
  onSelect,
  tone,
  workspace,
  communities,
  windows,
  navigationControls,
  onCommunitySelect,
  launchers,
  companion,
  children,
}: {
  pages: readonly RegisteredPage[];
  /** Launcher panels living in this window; they count as tabs for move targets. */
  panelCount?: number;
  selected: string;
  onSelect: (key: string) => void;
  tone: string;
  workspace?: boolean;
  communities: Communities;
  windows: WindowHost;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  launchers?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const layout = useSyncExternalStore(windows.subscribe, windows.snapshot);
  // Detached windows carry only the tab strip; community, Settings and profile stay in main.
  const main = windows.isMain;
  const ordered = orderPages(pages);
  const tabsHere = ordered.length + panelCount;
  const fillsWorkspace = workspace || selected === "settings";
  // A hovering tab highlights where it would land: launcher panels join the
  // launcher row; pages join the tab strip.
  const hovering = layout.dropTarget?.tab;
  const landsInLaunchers = !!hovering && hovering.startsWith("panel:");
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden bg-shell text-ink"
    >
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        data-tauri-drag-region={macDesktop ? undefined : true}
        {...titleBarDragProps}
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div
          className="shell-communities"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {navigationControls}
          {main && (
            <CommunitySwitcher
              communities={communities}
              onSelect={onCommunitySelect}
            />
          )}
        </div>
        <nav
          aria-label="Pages"
          className="shell-pages"
          data-drop-target={(!!hovering && !landsInLaunchers) || undefined}
        >
          {main && (
            <NavigationItem
              type="button"
              variant="pill"
              aria-current={selected === "home" ? "page" : undefined}
              onClick={() => onSelect("home")}
              selected={selected === "home"}
              label="Home"
              icon={<HouseIcon aria-hidden="true" size={15} />}
            />
          )}
          {ordered.map((page) => {
            const { label, icon: Icon } = pagePresentation(page);
            return (
              <PageTab
                key={page.key}
                tabKey={page.key}
                name={label}
                icon={<Icon aria-hidden="true" size={15} />}
                selected={selected === page.key}
                onSelect={() => onSelect(page.key)}
                windows={windows}
                layout={layout.layout}
                tabsHere={tabsHere}
                detachable={layout.enabled}
              />
            );
          })}
        </nav>
        <div
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          <div
            className="shell-actions-group"
            data-drop-target={landsInLaunchers || undefined}
            data-tauri-drag-region={macDesktop ? undefined : true}
            {...titleBarDragProps}
          >
            {launchers}
            {main && <PageSearch pages={pages} onSelect={onSelect} />}
            {main && (
              <ProfileButton
                communities={communities}
                settingsSelected={selected === "settings"}
                onSettings={() => onSelect("settings")}
              />
            )}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-0 min-w-0 flex-1 overflow-hidden px-2 pb-2 sm:px-4 sm:pb-4"
        >
          <PanelFrame companion={companion}>
            <div
              className={
                fillsWorkspace
                  ? "h-full min-h-0"
                  : "h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
              }
            >
              <div
                className={
                  fillsWorkspace ? "h-full min-h-0" : "mx-auto w-full max-w-4xl"
                }
              >
                {children}
              </div>
            </div>
          </PanelFrame>
        </main>
      </div>
    </div>
  );
}
