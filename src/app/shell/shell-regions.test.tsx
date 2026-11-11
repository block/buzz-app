// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import type { RegisteredPage } from "../../features/pages/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createAppearance } from "../../shared/theme/service";
import { createServices, type AppServices } from "../services";
import { AppShell } from "./AppShell";
import docs from "../../../docs/plugin-architecture.md?raw";

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

/** The regions in docs/plugin-architecture.md#shell-regions. `timeline` and
 * `composer` mount in the heavier owner tests (ChannelTimeline, ThreadPanel and
 * MessageComposer); the rest are rendered here. */
const DOCUMENTED = [
  "top-bar",
  "rail",
  "sidebar",
  "sidebar-header",
  "main",
  "main-header",
  "side-pane",
  "timeline",
  "composer",
];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});

const region = (name: string) =>
  document.querySelectorAll(`[data-shell-region="${name}"]`);

function Workspace({ main }: { main?: true }) {
  return (
    <PanelWorkspace
      {...(main ? { main } : {})}
      value="one"
      select={() => {}}
      items={[{ id: "one", label: "One", content: <p>One</p> }]}
    />
  );
}

it("documents exactly the regions the shell contract promises", () => {
  const section = docs.slice(docs.indexOf("### Shell regions"));
  const table = section.slice(
    0,
    section.indexOf("\n\n", section.indexOf("| --- |")),
  );
  const names = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map(
    (match) => match[1],
  );
  expect(names).toEqual(DOCUMENTED);
});

it("renders each documented shell region where the contract places it", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "channels",
      key: "buzz.channels/channels",
      pluginId: "buzz.channels",
      revision: "1",
      title: "Channels",
      component: () => null,
      primary: true,
    },
  ];
  const sidebar = (links: ReactNode) => (
    <SidebarFrame label="Sidebar" header={<p>Scope</p>}>
      {links}
    </SidebarFrame>
  );
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={createAppearance(window)}
      >
        <Workspace main />
        <Workspace />
      </AppShell>
    </ToastProvider>,
  );
  const only = (name: string) => {
    const found = region(name);
    expect(found, name).toHaveLength(1);
    return found[0] as HTMLElement;
  };
  expect(only("top-bar").tagName).toBe("HEADER");
  expect(only("top-bar")).toContainElement(
    document.querySelector(".shell-menu-search"),
  );
  expect(only("rail")).toHaveAccessibleName("Apps dock");
  expect(only("sidebar")).toBe(document.getElementById("shell-navigation"));
  expect(only("sidebar")).toContainElement(only("sidebar-header"));
  expect(only("sidebar-header")).toHaveTextContent("Scope");
  const main = only("main");
  expect(main).toHaveAttribute("data-main-workspace");
  expect(main).toContainElement(only("main-header"));
  expect(only("main-header").tagName).toBe("HEADER");
  const side = only("side-pane");
  expect(side).toHaveAttribute("data-panel-workspace");
  expect(side.querySelector('[data-shell-region="main-header"]')).toBeNull();
});

it("marks no region when a page has no sidebar header, secondary pane or main workspace", () => {
  render(<SidebarFrame label="Sidebar" />);
  expect(region("sidebar-header")).toHaveLength(0);
  expect(region("main")).toHaveLength(0);
  expect(region("side-pane")).toHaveLength(0);
});
