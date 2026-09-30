// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries; responsive geometry is covered in browser tests.
beforeEach(() => {
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
});

it("hides and shows the channel sidebar without re-rendering its content", async () => {
  const current = createServices();
  services = current;
  const renders = vi.fn();
  function Sidebar({ children }: { children: ReactNode }) {
    renders();
    return (
      <aside aria-label="Channel sidebar" className="shell-sidebar">
        {children}
      </aside>
    );
  }
  const sidebar = (pages: ReactNode) => <Sidebar>{pages}</Sidebar>;
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={[]}
        selected={selected}
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  const content = screen.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const navigation = content.parentElement;
  const rendered = renders.mock.calls.length;

  for (const [label, hidden] of [
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(navigation).toHaveAttribute("aria-hidden", hidden);
  }
  expect(content).toBeInTheDocument();
  expect(renders).toHaveBeenCalledTimes(rendered);

  // Shell inputs that the sidebar receives still reach it.
  rerender(shell("buzz.agents/agents"));
  expect(renders.mock.calls.length).toBeGreaterThan(rendered);
});
