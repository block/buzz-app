// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import type { HuddleView } from "../../features/huddle/window";
import { HuddleWindowView } from "./HuddleWindowView";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows and clears the connected call's voice error alongside window errors", () => {
  const view: HuddleView = {
    id: "call",
    title: "Huddle",
    phase: "connected",
    muted: false,
    level: 0,
    dark: false,
    participants: [],
    error: "Codex: Voice disconnected. Leave and rejoin the Huddle to retry.",
  };
  const act = vi.fn();
  const mounted = render(<HuddleWindowView view={view} act={act} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Codex: Voice disconnected.",
  );
  mounted.rerender(
    <HuddleWindowView
      view={view}
      act={act}
      error="Couldn’t update the call."
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn’t update the call.",
  );
  mounted.rerender(<HuddleWindowView view={view} act={act} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Codex: Voice disconnected.",
  );
  mounted.rerender(
    <HuddleWindowView view={{ ...view, error: undefined }} act={act} />,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
